/**
 * CONTENT SCRIPT — runs in the isolated world of the page.
 *
 * Responsibilities:
 *   1. Inject page-bridge.js into the page's MAIN world (where
 *      document.modelContext lives).
 *   2. Relay requests from the service worker to the bridge via window.postMessage,
 *      and relay bridge responses back to the service worker.
 *
 * This layer performs NO tool logic itself; it is a transport bridge only.
 */
import type {
  BridgeRequest,
  BridgeResponse,
  ContentReply,
  WorkerToContentMessage,
} from "../agent/types";

const SOURCE = "webmcp-agent";

/* -- 1. Inject the MAIN-world bridge exactly once -------------------------- */
function injectBridge(): void {
  const url = chrome.runtime.getURL("content/page-bridge.js");
  const script = document.createElement("script");
  script.type = "module";
  script.src = url;
  script.dataset.webmcpAgent = "bridge";
  (document.head || document.documentElement).appendChild(script);
  // Keep the tag; removing it does not unload the module, and leaving it is
  // harmless. This keeps behavior predictable across SPA re-renders.
}
injectBridge();

/* -- 2. Promise-based request/response over window.postMessage ------------- */
let counter = 0;
const pending = new Map<string, (res: BridgeResponse) => void>();

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return; // only accept from this page
  const data = event.data as Partial<BridgeResponse> | undefined;
  if (!data || data.source !== SOURCE || data.direction !== "response" || !data.id) return;
  const resolve = pending.get(data.id);
  if (resolve) {
    pending.delete(data.id);
    resolve(data as BridgeResponse);
  }
});

type BridgeOp =
  | { op: "getTools" }
  | { op: "executeTool"; toolName: string; argsJson: string }
  | { op: "promptAvailability" }
  | { op: "prompt"; prompt: string; responseConstraint?: Record<string, unknown> };

function callBridge(req: BridgeOp, timeoutMs = 15_000): Promise<BridgeResponse> {
  const id = `req-${Date.now()}-${counter++}`;
  const full = { source: SOURCE, direction: "request", id, ...req } as BridgeRequest;
  return new Promise<BridgeResponse>((resolve) => {
    const timeout = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({
          source: SOURCE,
          direction: "response",
          id,
          ok: false,
          error: `Timed out waiting for the page bridge (${Math.round(timeoutMs / 1000)}s).`,
        });
      }
    }, timeoutMs);

    pending.set(id, (res) => {
      clearTimeout(timeout);
      resolve(res);
    });

    window.postMessage(full, window.location.origin === "null" ? "*" : window.location.origin);
  });
}

/* -- 3. Handle messages from the service worker ---------------------------- */
chrome.runtime.onMessage.addListener(
  (msg: WorkerToContentMessage, _sender, sendResponse: (r: ContentReply) => void) => {
    (async () => {
      if (msg.type === "WEBMCP_GET_TOOLS") {
        const res = await callBridge({ op: "getTools" });
        sendResponse(res.ok ? { ok: true, tools: res.tools ?? [] } : { ok: false, error: res.error });
        return;
      }
      if (msg.type === "WEBMCP_EXECUTE_TOOL") {
        const res = await callBridge({
          op: "executeTool",
          toolName: msg.toolName,
          argsJson: msg.argsJson,
        });
        sendResponse(res.ok ? { ok: true, result: res.result ?? "" } : { ok: false, error: res.error });
        return;
      }
      if (msg.type === "PROMPT_AVAILABILITY") {
        const res = await callBridge({ op: "promptAvailability" });
        sendResponse(res.ok ? { ok: true, availability: res.availability } : { ok: false, error: res.error });
        return;
      }
      if (msg.type === "PROMPT_RUN") {
        // Prompt API can be slow on first use (model load / download), so give
        // it a generous timeout.
        const res = await callBridge(
          { op: "prompt", prompt: msg.prompt, responseConstraint: msg.responseConstraint },
          180_000,
        );
        sendResponse(res.ok ? { ok: true, text: res.text ?? "" } : { ok: false, error: res.error });
        return;
      }
    })();
    return true; // keep the message channel open for the async response
  },
);
