/**
 * Minimal Ollama /api/chat client.
 *
 * Supports two modes:
 *   - native tool calling: pass a `tools` array; the model returns
 *     message.tool_calls (OpenAI-style function schema).
 *   - structured JSON fallback: no `tools`; we instruct the model to answer
 *     ONLY with a strict JSON object and force `format: "json"`.
 *
 * We use non-streaming requests (stream: false) to keep the agent loop simple
 * and easy to debug — one request, one JSON response.
 */
import type { AgentConfig } from "../config";
import type { WebMcpTool } from "./types";

/* ---- Ollama chat message shapes ----------------------------------------- */

export interface OllamaToolCall {
  function: {
    name: string;
    /** Ollama returns arguments as an object (already parsed). */
    arguments: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** For role: "tool" — name of the tool this result belongs to. */
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  error?: string;
}

/** OpenAI-style tool definition Ollama expects in the `tools` field. */
interface OllamaToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toOllamaTools(tools: WebMcpTool[]): OllamaToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters:
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {} },
    },
  }));
}

/* ---- Requests ----------------------------------------------------------- */

async function postChat(
  cfg: AgentConfig,
  body: Record<string, unknown>,
): Promise<OllamaMessage> {
  const url = `${cfg.ollamaUrl.replace(/\/$/, "")}/api/chat`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, stream: false, ...body }),
    });
  } catch (err) {
    throw new Error(
      `Cannot reach Ollama at ${cfg.ollamaUrl}. Is it running? ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama returned HTTP ${res.status}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as OllamaChatResponse;
  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  if (!data.message) throw new Error("Ollama response did not contain a message.");
  return data.message;
}

/** Native tool-calling chat request. */
export function chatWithTools(
  cfg: AgentConfig,
  messages: OllamaMessage[],
  tools: WebMcpTool[],
): Promise<OllamaMessage> {
  return postChat(cfg, { messages, tools: toOllamaTools(tools) });
}

/** Structured-JSON chat request (fallback). Forces JSON output. */
export function chatJsonMode(
  cfg: AgentConfig,
  messages: OllamaMessage[],
): Promise<OllamaMessage> {
  return postChat(cfg, { messages, format: "json" });
}
