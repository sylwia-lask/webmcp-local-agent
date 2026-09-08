/**
 * Central configuration. Edit `model` to switch the local model.
 *
 * These are DEFAULTS. The side panel lets you override the URL and model at
 * runtime; overrides are stored in chrome.storage.local and merged on top of
 * these defaults (see loadConfig).
 */
export interface AgentConfig {
  /**
   * Which LLM backend to use:
   *  - "ollama": local Ollama server (native tools + JSON fallback).
   *  - "chrome": Chrome built-in Prompt API (LanguageModel / Gemini Nano),
   *              JSON protocol only.
   *  - "gemini": Google Gemini via API key (cloud; native function calling).
   */
  provider: "ollama" | "chrome" | "gemini";
  /** Base URL of the local Ollama server. */
  ollamaUrl: string;
  /** Model name as it appears in `ollama list`, e.g. "llama3.1" or "qwen2.5". */
  model: string;
  /**
   * Gemini API key (cloud provider). Empty by default — enter it only in the
   * UI. Never commit a real key. Stored in chrome.storage.local.
   */
  apiKey: string;
  /**
   * Preferred Gemini model. If a request fails with "model not found", the
   * provider automatically falls back through GEMINI_FALLBACK_MODELS.
   */
  geminiModel: string;
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
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  model: "llama3.1",
  apiKey: "",
  geminiModel: "gemini-3.8-flash",
  toolMode: "auto",
  maxSteps: 5,
};

/**
 * Fallback chain for the Gemini provider, newest first. If the configured
 * model isn't available for the key, the provider tries the next one.
 */
export const GEMINI_FALLBACK_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
] as const;

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
