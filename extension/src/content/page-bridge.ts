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
  // The argument shape differs between Chrome channels: newer builds (spec-
  // compliant) take a JS object, older/stable builds take a JSON string. We
  // accept both here and pick the right one at call time.
  executeTool: (
    tool: RawTool,
    args: Record<string, unknown> | string,
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

/**
 * Call executeTool() in a way that works across Chrome channels.
 *
 * Newer/Beta builds follow the current spec and expect a JS object for the
 * arguments. Older/stable builds expect a JSON string and throw
 * "Failed to parse input arguments" (an UnknownError/TypeError) when handed an
 * object. We try the object form first, and only fall back to the string form
 * when the failure looks like an argument-shape mismatch — never for genuine
 * tool errors, which must surface to the caller unchanged.
 */
async function executeWithArgCompat(
  mc: ModelContextLike,
  tool: RawTool,
  argsObject: Record<string, unknown>,
  argsString: string,
): Promise<unknown> {
  try {
    return await mc.executeTool(tool, argsObject);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/parse input arguments|is not an object|invalid input object/i.test(message)) {
      // Older API shape: retry with the raw JSON string.
      return await mc.executeTool(tool, argsString);
    }
    throw err;
  }
}

/* ---- Chrome Prompt API (LanguageModel) ---------------------------------- */
// Also a main-world global, so we reach it from the same bridge.

interface LanguageModelSession {
  prompt: (input: string, opts?: { responseConstraint?: unknown }) => Promise<string>;
  destroy?: () => void;
}

interface LanguageModelStatic {
  availability: () => Promise<string>;
  create: () => Promise<LanguageModelSession>;
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
      // Validate and normalize the incoming arguments. We carry them across the
      // message boundary as a JSON string; parse to an object for the newer API
      // shape, but keep the original string for the older/stable API shape.
      let argsObject: Record<string, unknown>;
      const argsString = req.argsJson.trim() === "" ? "{}" : req.argsJson;
      try {
        const parsed = JSON.parse(argsString);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("arguments must be a JSON object");
        }
        argsObject = parsed as Record<string, unknown>;
      } catch (parseErr) {
        post({
          source: SOURCE,
          direction: "response",
          id: req.id,
          ok: false,
          error: `Invalid arguments for tool "${req.toolName}": ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`,
        });
        return;
      }

      // Chrome channels disagree on the argument shape: newer/Beta builds want
      // a JS object, older/stable builds want a JSON string and throw
      // "Failed to parse input arguments" when given an object. Try the
      // spec-compliant object form first, then fall back to the string form.
      const result = await executeWithArgCompat(mc, live, argsObject, argsString);
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
    // First use can trigger an on-device model download; create() awaits it.
    // This is why the prompt bridge uses a generous timeout in the content script.
    const session = await lm.create();
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
