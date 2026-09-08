/**
 * PAGE BRIDGE — runs in the page's MAIN world.
 *
 * document.modelContext (WebMCP) only exists in the page's main world, so a
 * normal isolated-world content script cannot see it. This script is injected
 * into the main world by the content script and talks to it over
 * window.postMessage.
 *
 * It NEVER executes arbitrary code from the page or the model. It only:
 *   - reads the tool list via document.modelContext.getTools()
 *   - executes a named tool via document.modelContext.executeTool(tool, argsJson)
 */
import type { BridgeRequest, BridgeResponse, WebMcpTool } from "../agent/types";

const SOURCE = "webmcp-agent";

interface ModelContextLike {
  getTools: (opts?: { fromOrigins?: string[] }) => Promise<RawTool[]>;
  executeTool: (
    tool: RawTool,
    argsJson: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<unknown>;
}

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  title?: string;
  origin?: string;
  annotations?: WebMcpTool["annotations"];
}

function getModelContext(): ModelContextLike | null {
  const mc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  return mc ?? null;
}

/* ---- Chrome Prompt API (LanguageModel) ---------------------------------- */
// Also a main-world global, so we reach it from the same bridge.

interface LanguageModelSession {
  prompt: (input: string, opts?: { responseConstraint?: unknown }) => Promise<string>;
  destroy?: () => void;
}

interface LanguageModelCreateOptions {
  monitor?: (m: EventTarget) => void;
}

interface LanguageModelStatic {
  availability: () => Promise<string>;
  create: (opts?: LanguageModelCreateOptions) => Promise<LanguageModelSession>;
}

function getLanguageModel(): LanguageModelStatic | null {
  const lm = (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;
  return lm ?? null;
}

/** Strip non-serializable fields (e.g. the live `window` ref) for messaging. */
function toSerializable(tool: RawTool): WebMcpTool {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    title: tool.title,
    origin: tool.origin,
    annotations: tool.annotations,
  };
}

function post(response: BridgeResponse): void {
  window.postMessage(response, window.location.origin === "null" ? "*" : window.location.origin);
}

async function handle(req: BridgeRequest): Promise<void> {
  // Chrome Prompt API ops don't need WebMCP, so handle them first.
  if (req.op === "promptAvailability" || req.op === "prompt") {
    await handlePrompt(req);
    return;
  }

  const mc = getModelContext();
  if (!mc) {
    post({
      source: SOURCE,
      direction: "response",
      id: req.id,
      ok: false,
      error:
        "WebMCP is not available on this page (document.modelContext is undefined). " +
        "The page may not register any tools, or the Chromium WebMCP flag is off.",
    });
    return;
  }

  try {
    if (req.op === "getTools") {
      const raw = await mc.getTools();
      const tools = Array.isArray(raw) ? raw.map(toSerializable) : [];
      post({ source: SOURCE, direction: "response", id: req.id, ok: true, tools });
      return;
    }

    if (req.op === "executeTool") {
      // Re-fetch the live tool objects and match by name. executeTool expects
      // the actual tool object returned by getTools(), not a plain string.
      const raw = await mc.getTools();
      const live = Array.isArray(raw) ? raw.find((t) => t.name === req.toolName) : undefined;
      if (!live) {
        post({
          source: SOURCE,
          direction: "response",
          id: req.id,
          ok: false,
          error: `Tool "${req.toolName}" is not currently available on this page.`,
        });
        return;
      }
      const result = await mc.executeTool(live, req.argsJson);
      const text =
        result == null
          ? "(no result — the tool may have triggered a navigation)"
          : typeof result === "string"
            ? result
            : JSON.stringify(result);
      post({ source: SOURCE, direction: "response", id: req.id, ok: true, result: text });
      return;
    }
  } catch (err) {
    post({
      source: SOURCE,
      direction: "response",
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type PromptRequest = Extract<BridgeRequest, { op: "promptAvailability" | "prompt" }>;

async function handlePrompt(req: PromptRequest): Promise<void> {
  const lm = getLanguageModel();

  if (req.op === "promptAvailability") {
    if (!lm) {
      post({ source: SOURCE, direction: "response", id: req.id, ok: true, availability: "unavailable" });
      return;
    }
    try {
      const availability = await lm.availability();
      post({ source: SOURCE, direction: "response", id: req.id, ok: true, availability });
    } catch (err) {
      post({
        source: SOURCE,
        direction: "response",
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // op === "prompt"
  if (!lm) {
    post({
      source: SOURCE,
      direction: "response",
      id: req.id,
      ok: false,
      error:
        "Chrome Prompt API is not available (window.LanguageModel is undefined). " +
        "Use a Chrome version with the built-in AI / Prompt API enabled.",
    });
    return;
  }
  try {
    // First use can trigger an on-device model download; the monitor surfaces
    // progress instead of appearing to hang.
    const session = await lm.create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const ev = e as ProgressEvent;
          console.debug(`[webmcp-agent] model download: ${Math.round((ev.loaded ?? 0) * 100)}%`);
        });
      },
    });
    try {
      const text = await session.prompt(
        req.prompt,
        req.responseConstraint ? { responseConstraint: req.responseConstraint } : undefined,
      );
      post({ source: SOURCE, direction: "response", id: req.id, ok: true, text });
    } finally {
      session.destroy?.();
    }
  } catch (err) {
    post({
      source: SOURCE,
      direction: "response",
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Partial<BridgeRequest> | undefined;
  if (!data || data.source !== SOURCE || data.direction !== "request") return;
  void handle(data as BridgeRequest);
});
