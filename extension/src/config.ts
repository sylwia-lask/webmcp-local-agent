/**
 * Central configuration. Edit `model` to switch the local model.
 *
 * These are DEFAULTS. The side panel lets you override the URL and model at
 * runtime; overrides are stored in chrome.storage.local and merged on top of
 * these defaults (see loadConfig).
 */
export interface AgentConfig {
  /** Base URL of the local Ollama server. */
  ollamaUrl: string;
  /** Model name as it appears in `ollama list`, e.g. "llama3.1" or "qwen2.5". */
  model: string;
  /**
   * Tool-calling strategy:
   *  - "native": use Ollama's /api/chat `tools` field (model must support tools).
   *  - "json":   force a structured-JSON protocol (works with any model).
   *  - "auto":   try native; if the model errors or never calls a tool, the
   *              agent falls back to the JSON protocol automatically.
   */
  toolMode: "native" | "json" | "auto";
  /** Hard cap on agent loop iterations to prevent infinite loops. */
  maxSteps: number;
}

export const DEFAULT_CONFIG: AgentConfig = {
  ollamaUrl: "http://localhost:11434",
  model: "llama3.1",
  toolMode: "auto",
  maxSteps: 5,
};

const STORAGE_KEY = "webmcp-agent-config";

/** Load config: defaults overlaid with any user overrides from storage. */
export async function loadConfig(): Promise<AgentConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const overrides = (stored?.[STORAGE_KEY] ?? {}) as Partial<AgentConfig>;
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Persist a partial config override. */
export async function saveConfig(patch: Partial<AgentConfig>): Promise<void> {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}
