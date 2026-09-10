/**
 * SIDE PANEL UI.
 *
 * - Renders config (Ollama URL, model, tool mode, max steps).
 * - Sends the prompt + active tab id to the service worker.
 * - Receives streamed AgentEvents over a long-lived port and renders the log.
 */
import { loadConfig, saveConfig, type AgentConfig } from "../config";
import type { AgentEvent, PanelToWorkerMessage, WebMcpTool } from "../agent/types";
import { Dropdown } from "./dropdown";

/* ---- Element helpers ---------------------------------------------------- */
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

// Custom dropdowns replace native <select>, which can fail to open its option
// popup inside Chrome's side panel on some Chrome versions (crbug 534387029).
const providerSelect = new Dropdown(
  [
    { value: "chrome", label: "Chrome Prompt API" },
    { value: "ollama", label: "Ollama" },
    { value: "gemini", label: "Gemini (cloud)" },
  ],
);
$("providerMount").appendChild(providerSelect.el);
const toggleConfigBtn = $("toggleConfig");
const toggleToolsBtn = $("toggleTools");
const toolsBadge = $("toolsBadge");
const toolsPanel = $("toolsPanel");
const toolsList = $("toolsList");
const refreshToolsBtn = $("refreshTools");
const configPanel = $("configPanel");
const ollamaConfig = $("ollamaConfig");
const chromeConfig = $("chromeConfig");
const geminiConfig = $("geminiConfig");
const ollamaUrlInput = $<HTMLInputElement>("ollamaUrl");
const modelInput = $<HTMLInputElement>("model");
const apiKeyInput = $<HTMLInputElement>("apiKey");
const geminiModelInput = $<HTMLInputElement>("geminiModel");
const toolModeSelect = new Dropdown(
  [
    { value: "auto", label: "auto (native, fallback to JSON)" },
    { value: "native", label: "native tool calling" },
    { value: "json", label: "structured JSON" },
  ],
);
$("toolModeMount").appendChild(toolModeSelect.el);
const maxStepsInput = $<HTMLInputElement>("maxSteps");
const saveConfigBtn = $("saveConfig");
const promptInput = $<HTMLTextAreaElement>("prompt");
const runBtn = $<HTMLButtonElement>("run");
const clearBtn = $("clear");
const logEl = $("log");

/* ---- Config -------------------------------------------------------------- */
async function refreshConfigUI(): Promise<void> {
  const cfg = await loadConfig();
  providerSelect.value = cfg.provider;
  ollamaUrlInput.value = cfg.ollamaUrl;
  modelInput.value = cfg.model;
  apiKeyInput.value = cfg.apiKey;
  geminiModelInput.value = cfg.geminiModel;
  toolModeSelect.value = cfg.toolMode;
  maxStepsInput.value = String(cfg.maxSteps);
  applyProviderUI(cfg);
}

/** Show only the config group that belongs to the active provider. */
function applyProviderUI(cfg: AgentConfig): void {
  const isChrome = cfg.provider === "chrome";
  const isGemini = cfg.provider === "gemini";
  const isOllama = cfg.provider === "ollama";
  ollamaConfig.classList.toggle("hidden", !isOllama);
  chromeConfig.classList.toggle("hidden", !isChrome);
  geminiConfig.classList.toggle("hidden", !isGemini);
}

// One-click provider switch: persist immediately, no need to open config.
providerSelect.el.addEventListener("change", async () => {
  const provider = providerSelect.value as AgentConfig["provider"];
  await saveConfig({ provider });
  const cfg = await loadConfig();
  applyProviderUI(cfg);
  appendEntry({ kind: "info", message: `Provider switched to ${providerSelect.selectedText}.` });
});

toggleConfigBtn.addEventListener("click", () => {
  configPanel.classList.toggle("hidden");
  toolsPanel.classList.add("hidden");
});

toggleToolsBtn.addEventListener("click", () => {
  toolsPanel.classList.toggle("hidden");
  configPanel.classList.add("hidden");
});

refreshToolsBtn.addEventListener("click", () => void loadTools());

saveConfigBtn.addEventListener("click", async () => {
  const patch: Partial<AgentConfig> = {
    ollamaUrl: ollamaUrlInput.value.trim() || "http://localhost:11434",
    model: modelInput.value.trim() || "llama3.1",
    apiKey: apiKeyInput.value.trim(),
    geminiModel: geminiModelInput.value.trim() || "gemini-3.8-flash",
    toolMode: toolModeSelect.value as AgentConfig["toolMode"],
    maxSteps: Math.max(1, Math.min(20, Number(maxStepsInput.value) || 5)),
  };
  await saveConfig(patch);
  await refreshConfigUI();
  configPanel.classList.add("hidden");
  appendEntry({ kind: "info", message: "Config saved." });
});

/* ---- Log rendering ------------------------------------------------------- */
function makeEntry(cls: string, label: string): HTMLElement {
  const entry = document.createElement("div");
  entry.className = `entry ${cls}`;
  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  entry.appendChild(l);
  logEl.appendChild(entry);
  return entry;
}

function withBody(entry: HTMLElement, text: string, pre = false): void {
  if (text) {
    const body = document.createElement(pre ? "pre" : "div");
    if (!pre) body.className = "body";
    body.textContent = text;
    entry.appendChild(body);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

/** Compact, single-line-ish rendering of tool arguments for the log. */
function formatArgs(args: unknown): string {
  if (args == null) return "(no arguments)";
  if (typeof args === "object" && Object.keys(args as object).length === 0) {
    return "(no arguments)";
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function appendEntry(event: AgentEvent): void {
  switch (event.kind) {
    case "user_prompt":
      withBody(makeEntry("user_prompt", "User prompt"), event.text);
      break;
    case "tools_discovered":
      // Intentionally not rendered in the log. The discovered tools are shown
      // in the dedicated "Tools" tab (populated out-of-band via tools_list).
      break;
    case "model_request":
      withBody(makeEntry("model_request", `Step ${event.step} → model`), event.note);
      break;
    case "tool_call":
      // Announce which tool the agent is calling, with its arguments — but do
      // not dump raw results. Keep it to a concise one-liner.
      withBody(
        makeEntry("tool_call", `Step ${event.step} · called ${event.tool}`),
        formatArgs(event.args),
      );
      break;
    case "tool_result":
      // The raw tool result is fed back to the model, not shown to the user.
      // We only note that the call completed.
      withBody(makeEntry("tool_result", `Step ${event.step} · ${event.tool} completed`), "");
      break;
    case "final":
      withBody(makeEntry("final", "Final answer"), event.message);
      break;
    case "error":
      withBody(makeEntry("error", "Error"), event.message);
      break;
    case "info":
      withBody(makeEntry("info", "Info"), event.message);
      break;
    case "confirm_tool":
      renderConfirmPrompt(event);
      break;
  }
}

/**
 * Render an inline confirmation prompt for a consequential tool call. The
 * agent loop is blocked until the user clicks Approve or Decline, at which
 * point we post a CONFIRM_TOOL message back to the worker.
 */
function renderConfirmPrompt(event: Extract<AgentEvent, { kind: "confirm_tool" }>): void {
  const entry = makeEntry("confirm_tool", `Step ${event.step} · confirm ${event.title || event.tool}`);

  const warn = document.createElement("div");
  warn.className = "body";
  warn.textContent =
    "This tool is marked as consequential (a high-stakes or non-reversible action). " +
    "Allow the agent to run it?";
  entry.appendChild(warn);

  if (event.description) {
    const desc = document.createElement("div");
    desc.className = "confirm-desc";
    desc.textContent = event.description;
    entry.appendChild(desc);
  }

  const args = document.createElement("pre");
  args.textContent = formatArgs(event.args);
  entry.appendChild(args);

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const approveBtn = document.createElement("button");
  approveBtn.className = "confirm-approve";
  approveBtn.textContent = "Approve";

  const declineBtn = document.createElement("button");
  declineBtn.className = "confirm-decline";
  declineBtn.textContent = "Decline";

  const respond = (approved: boolean): void => {
    approveBtn.disabled = true;
    declineBtn.disabled = true;
    const decisionEl = document.createElement("div");
    decisionEl.className = "confirm-decision";
    decisionEl.textContent = approved ? "Approved." : "Declined.";
    entry.appendChild(decisionEl);
    const msg: PanelToWorkerMessage = { type: "CONFIRM_TOOL", id: event.id, approved };
    ensurePort().postMessage(msg);
  };

  approveBtn.addEventListener("click", () => respond(true));
  declineBtn.addEventListener("click", () => respond(false));

  actions.appendChild(approveBtn);
  actions.appendChild(declineBtn);
  entry.appendChild(actions);

  logEl.scrollTop = logEl.scrollHeight;
}

clearBtn.addEventListener("click", () => {
  logEl.replaceChildren();
});

/* ---- Tools tab ----------------------------------------------------------- */
type BadgeState = "loading" | number | "unavailable";

function setToolsBadge(state: BadgeState): void {
  toolsBadge.classList.remove("loading", "empty");
  if (state === "loading") {
    toolsBadge.textContent = "…";
    toolsBadge.classList.add("loading");
    toolsBadge.title = "Checking for WebMCP tools…";
  } else if (state === "unavailable") {
    toolsBadge.textContent = "×";
    toolsBadge.classList.add("empty");
    toolsBadge.title = "WebMCP unavailable on this page";
  } else {
    toolsBadge.textContent = String(state);
    if (state === 0) toolsBadge.classList.add("empty");
    toolsBadge.title = `${state} WebMCP tool${state === 1 ? "" : "s"} on this page`;
  }
}

function renderToolsTab(available: boolean, tools: WebMcpTool[], error?: string): void {
  toolsList.replaceChildren();

  if (!available) {
    setToolsBadge("unavailable");
    const msg = document.createElement("p");
    msg.className = "tools-empty";
    msg.textContent = "WebMCP unavailable on this page.";
    toolsList.appendChild(msg);
    if (error) {
      const detail = document.createElement("p");
      detail.className = "tools-empty-detail";
      detail.textContent = error;
      toolsList.appendChild(detail);
    }
    return;
  }

  setToolsBadge(tools.length);

  if (tools.length === 0) {
    const msg = document.createElement("p");
    msg.className = "tools-empty";
    msg.textContent = "No WebMCP tools registered on this page yet.";
    toolsList.appendChild(msg);
    return;
  }

  for (const tool of tools) {
    const item = document.createElement("div");
    item.className = "tool-item";

    const name = document.createElement("div");
    name.className = "tool-name";
    name.textContent = tool.title || tool.name;
    item.appendChild(name);

    if (tool.title && tool.title !== tool.name) {
      const id = document.createElement("div");
      id.className = "tool-id";
      id.textContent = tool.name;
      item.appendChild(id);
    }

    const desc = document.createElement("div");
    desc.className = "tool-desc";
    desc.textContent = tool.description || "(no description)";
    item.appendChild(desc);

    // Surface risk annotations so it's obvious which tools will trigger a
    // confirmation prompt (consequentialHint) before the agent runs them.
    const hints: string[] = [];
    if (tool.annotations?.consequentialHint === true) hints.push("⚠ consequential (asks before running)");
    if (tool.annotations?.readOnlyHint === true) hints.push("read-only");
    if (tool.annotations?.untrustedContentHint === true) hints.push("untrusted content");
    if (hints.length) {
      const ann = document.createElement("div");
      ann.className = "tool-annotations";
      ann.textContent = hints.join(" · ");
      item.appendChild(ann);
    }

    toolsList.appendChild(item);
  }
}

async function loadTools(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId == null) {
    renderToolsTab(false, [], "No active tab found.");
    return;
  }
  setToolsBadge("loading");
  const msg: PanelToWorkerMessage = { type: "LIST_TOOLS", tabId };
  ensurePort().postMessage(msg);
}

// Re-check tools when the user switches tabs or navigates the active tab.
chrome.tabs.onActivated.addListener(() => void loadTools());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === "complete") void loadTools();
});

/* ---- Running the agent --------------------------------------------------- */
async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

let port: chrome.runtime.Port | null = null;
function ensurePort(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connect({ name: "agent" });
  port.onMessage.addListener((event: AgentEvent) => {
    // The tools listing is out-of-band: it feeds the "Tools" tab, not the log.
    if (event.kind === "tools_list") {
      renderToolsTab(event.available, event.tools, event.error);
      return;
    }
    appendEntry(event);
    if (event.kind === "final" || event.kind === "error") {
      runBtn.disabled = false;
      runBtn.textContent = "Run";
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    runBtn.disabled = false;
    runBtn.textContent = "Run";
  });
  return port;
}

async function run(): Promise<void> {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  const tabId = await activeTabId();
  if (tabId == null) {
    appendEntry({ kind: "error", message: "No active tab found." });
    return;
  }

  runBtn.disabled = true;
  runBtn.textContent = "Running…";

  const msg: PanelToWorkerMessage = { type: "RUN_AGENT", tabId, prompt };
  ensurePort().postMessage(msg);
}

runBtn.addEventListener("click", () => void run());
promptInput.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+Enter to run.
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void run();
});

/* ---- Init ---------------------------------------------------------------- */
void refreshConfigUI();
setToolsBadge("loading");
void loadTools();
