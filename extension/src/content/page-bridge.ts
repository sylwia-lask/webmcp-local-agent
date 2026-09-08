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

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Partial<BridgeRequest> | undefined;
  if (!data || data.source !== SOURCE || data.direction !== "request") return;
  void handle(data as BridgeRequest);
});
