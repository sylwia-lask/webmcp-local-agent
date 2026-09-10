/**
 * SERVICE WORKER (background).
 *
 * - Opens the side panel when the toolbar icon is clicked.
 * - Runs the agent loop (kept here so it keeps running even if the panel loses
 *   focus, and so Ollama fetches are not tied to the panel document).
 * - Bridges tool discovery/execution to the active tab's content script.
 * - Streams AgentEvents back to the panel via a long-lived port.
 */
import { loadConfig } from "../config";
import { runAgent } from "../agent/agent";
import type { LlmProvider } from "../agent/llm";
import { OllamaProvider } from "../agent/providers/ollama-provider";
import { ChromePromptApiProvider } from "../agent/providers/chrome-prompt-provider";
import { GeminiApiProvider } from "../agent/providers/gemini-provider";
import type {
  AgentEvent,
  ContentReply,
  JSONSchema,
  PanelToWorkerMessage,
  WebMcpTool,
  WorkerToContentMessage,
} from "../agent/types";

/**
 * Pending consequential-tool confirmations, keyed by request id. The agent
 * loop registers a resolver here and emits a `confirm_tool` event; the panel
 * later replies with a CONFIRM_TOOL message which resolves the promise.
 */
const pendingConfirmations = new Map<string, (approved: boolean) => void>();

function newConfirmationId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Open the side panel from the toolbar action.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* older Chrome: user opens the panel manually */
  });
});

/* ---- Talking to the active tab's content script ------------------------- */

function sendToTab(tabId: number, msg: WorkerToContentMessage): Promise<ContentReply> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (reply: ContentReply | undefined) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({
          ok: false,
          error:
            `Could not reach the page's content script (${err.message}). ` +
            "Reload the tab after installing the extension, and make sure it is a normal http(s) page.",
        });
        return;
      }
      resolve(reply ?? { ok: false, error: "No response from content script." });
    });
  });
}

async function getToolsFromTab(tabId: number): Promise<WebMcpTool[]> {
  const reply = await sendToTab(tabId, { type: "WEBMCP_GET_TOOLS" });
  if (!reply.ok) throw new Error(reply.error);
  return reply.tools ?? [];
}

async function executeToolInTab(tabId: number, toolName: string, argsJson: string): Promise<string> {
  const reply = await sendToTab(tabId, { type: "WEBMCP_EXECUTE_TOOL", toolName, argsJson });
  if (!reply.ok) throw new Error(reply.error);
  return reply.result ?? "";
}

/* ---- Chrome Prompt API via the tab bridge (main world) ------------------ */

async function promptAvailabilityInTab(tabId: number): Promise<string> {
  const reply = await sendToTab(tabId, { type: "PROMPT_AVAILABILITY" });
  if (!reply.ok) throw new Error(reply.error);
  return reply.availability ?? "unavailable";
}

async function promptInTab(tabId: number, prompt: string, responseConstraint?: JSONSchema): Promise<string> {
  const reply = await sendToTab(tabId, { type: "PROMPT_RUN", prompt, responseConstraint });
  if (!reply.ok) throw new Error(reply.error);
  return reply.text ?? "";
}

/** Build the selected provider, injecting tab-bound calls where needed. */
function buildProvider(cfg: Awaited<ReturnType<typeof loadConfig>>, tabId: number): LlmProvider {
  if (cfg.provider === "chrome") {
    return new ChromePromptApiProvider({
      availability: () => promptAvailabilityInTab(tabId),
      prompt: (input, responseConstraint) => promptInTab(tabId, input, responseConstraint),
    });
  }
  if (cfg.provider === "gemini") {
    return new GeminiApiProvider(cfg);
  }
  return new OllamaProvider(cfg);
}

/* ---- Panel port: stream events to the UI -------------------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent") return;

  const emit = (event: AgentEvent) => {
    try {
      port.postMessage(event);
    } catch {
      /* panel closed; ignore */
    }
  };

  port.onMessage.addListener((msg: PanelToWorkerMessage) => {
    if (msg.type === "RUN_AGENT") {
      void handleRun(msg.tabId, msg.prompt, emit);
    } else if (msg.type === "LIST_TOOLS") {
      void handleListTools(msg.tabId, emit);
    } else if (msg.type === "CONFIRM_TOOL") {
      const resolve = pendingConfirmations.get(msg.id);
      if (resolve) {
        pendingConfirmations.delete(msg.id);
        resolve(msg.approved);
      }
    }
  });

  // If the panel disconnects while a confirmation is pending, treat it as a
  // denial so the agent loop never hangs forever.
  port.onDisconnect.addListener(() => {
    for (const [, resolve] of pendingConfirmations) resolve(false);
    pendingConfirmations.clear();
  });
});

/**
 * Out-of-band tool discovery for the "Tools" tab. Never throws to the caller;
 * failures (no WebMCP on the page, unreachable content script) are reported as
 * `available: false` so the panel can show "unavailable".
 */
async function handleListTools(tabId: number, emit: (e: AgentEvent) => void): Promise<void> {
  try {
    const tools = await getToolsFromTab(tabId);
    emit({ kind: "tools_list", available: true, tools });
  } catch (err) {
    emit({
      kind: "tools_list",
      available: false,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleRun(
  tabId: number,
  prompt: string,
  emit: (e: AgentEvent) => void,
): Promise<void> {
  try {
    const cfg = await loadConfig();
    const provider = buildProvider(cfg, tabId);

    // Pre-flight availability check so we fail with a clear message instead of
    // crashing mid-loop.
    const availability = await provider.isAvailable();
    if (!availability.ok) {
      emit({
        kind: "error",
        message: `${provider.label} is not available. ${availability.detail ?? ""}`.trim(),
      });
      return;
    }

    if (cfg.provider === "chrome") {
      emit({ kind: "info", message: `Using ${provider.label} (Gemini Nano, JSON mode).` });
    } else if (cfg.provider === "gemini") {
      emit({
        kind: "info",
        message:
          `⚠ Using ${provider.label} model "${cfg.geminiModel}". ` +
          "This is a CLOUD provider — your prompt and the page's tool descriptions are sent to Google.",
      });
    } else {
      emit({
        kind: "info",
        message: `Using ${provider.label} model "${cfg.model}" at ${cfg.ollamaUrl} (${cfg.toolMode} mode).`,
      });
    }

    await runAgent(cfg, prompt, {
      provider,
      getTools: () => getToolsFromTab(tabId),
      executeTool: (name, argsJson) => executeToolInTab(tabId, name, argsJson),
      confirmConsequential: (tool, args, step) =>
        new Promise<boolean>((resolve) => {
          const id = newConfirmationId();
          pendingConfirmations.set(id, resolve);
          emit({
            kind: "confirm_tool",
            id,
            step,
            tool: tool.name,
            title: tool.title,
            description: tool.description,
            args,
          });
        }),
      emit,
    });
  } catch (err) {
    emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
