/**
 * SIDE PANEL UI.
 *
 * - Renders config (Ollama URL, model, tool mode, max steps).
 * - Sends the prompt + active tab id to the service worker.
 * - Receives streamed AgentEvents over a long-lived port and renders the log.
 */
import { loadConfig, saveConfig, type AgentConfig } from "../config";
import type { AgentEvent, PanelToWorkerMessage, WebMcpTool } from "../agent/types";

/* ---- Element helpers ---------------------------------------------------- */
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const modelLabel = $("modelLabel");
const modelLine = $("modelLine");
const providerSelect = $<HTMLSelectElement>("provider");
const toggleConfigBtn = $("toggleConfig");
const configPanel = $("configPanel");
const ollamaConfig = $("ollamaConfig");
const chromeConfigNote = $("chromeConfigNote");
const ollamaUrlInput = $<HTMLInputElement>("ollamaUrl");
const modelInput = $<HTMLInputElement>("model");
const toolModeSelect = $<HTMLSelectElement>("toolMode");
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
  toolModeSelect.value = cfg.toolMode;
  maxStepsInput.value = String(cfg.maxSteps);
  applyProviderUI(cfg.provider, cfg.model);
}

/** Show/hide provider-specific fields and update the header label. */
function applyProviderUI(provider: AgentConfig["provider"], model: string): void {
  const isChrome = provider === "chrome";
  ollamaConfig.classList.toggle("hidden", isChrome);
  chromeConfigNote.classList.toggle("hidden", !isChrome);
  modelLine.classList.toggle("hidden", isChrome);
  modelLabel.textContent = model;
}

// One-click provider switch: persist immediately, no need to open config.
providerSelect.addEventListener("change", async () => {
  const provider = providerSelect.value as AgentConfig["provider"];
  await saveConfig({ provider });
  const cfg = await loadConfig();
  applyProviderUI(provider, cfg.model);
  appendEntry({ kind: "info", message: `Provider switched to ${providerSelect.selectedOptions[0].text}.` });
});

toggleConfigBtn.addEventListener("click", () => configPanel.classList.toggle("hidden"));

saveConfigBtn.addEventListener("click", async () => {
  const patch: Partial<AgentConfig> = {
    ollamaUrl: ollamaUrlInput.value.trim() || "http://localhost:11434",
    model: modelInput.value.trim() || "llama3.1",
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
  const body = document.createElement(pre ? "pre" : "div");
  if (!pre) body.className = "body";
  body.textContent = text;
  entry.appendChild(body);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderTools(tools: WebMcpTool[]): string {
  if (tools.length === 0) return "(none)";
  return tools
    .map((t) => `• ${t.name} — ${t.description || "(no description)"}`)
    .join("\n");
}

function appendEntry(event: AgentEvent): void {
  switch (event.kind) {
    case "user_prompt":
      withBody(makeEntry("user_prompt", "User prompt"), event.text);
      break;
    case "tools_discovered":
      withBody(makeEntry("tools_discovered", `WebMCP tools (${event.tools.length})`), renderTools(event.tools), true);
      break;
    case "model_request":
      withBody(makeEntry("model_request", `Step ${event.step} → model`), event.note);
      break;
    case "tool_call":
      withBody(
        makeEntry("tool_call", `Step ${event.step} · tool call`),
        `${event.tool}(${JSON.stringify(event.args, null, 2)})`,
        true,
      );
      break;
    case "tool_result":
      withBody(makeEntry("tool_result", `Step ${event.step} · result of ${event.tool}`), event.result, true);
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
  }
}

clearBtn.addEventListener("click", () => {
  logEl.replaceChildren();
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
