/**
 * OllamaProvider — LlmProvider backed by a local Ollama server (/api/chat).
 *
 * Behavior is identical to the previous ollama.ts:
 *   - chatWithTools: native tool calling via the `tools` field
 *   - chatJson:      structured JSON via format:"json"
 *   - non-streaming (stream:false) for simple, debuggable request/response
 */
import type { AgentConfig } from "../../config";
import type { JSONSchema, WebMcpTool } from "../types";
import type { LlmMessage, LlmProvider } from "../llm";

interface OllamaChatResponse {
  message?: LlmMessage;
  error?: string;
}

/** OpenAI-style tool definition Ollama expects in the `tools` field. */
interface OllamaToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function toOllamaTools(tools: WebMcpTool[]): OllamaToolDef[] {
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

export class OllamaProvider implements LlmProvider {
  readonly label = "Ollama";
  readonly supportsNativeTools = true;

  constructor(private readonly cfg: AgentConfig) {}

  private get base(): string {
    return this.cfg.ollamaUrl.replace(/\/$/, "");
  }

  async isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.base}/api/tags`, { method: "GET" });
      if (!res.ok) return { ok: false, detail: `Ollama responded HTTP ${res.status}.` };
      return { ok: true, detail: `Reachable at ${this.cfg.ollamaUrl}.` };
    } catch (err) {
      return {
        ok: false,
        detail: `Cannot reach Ollama at ${this.cfg.ollamaUrl}. Is it running? (${
          err instanceof Error ? err.message : String(err)
        })`,
      };
    }
  }

  private async postChat(body: Record<string, unknown>): Promise<LlmMessage> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.cfg.model, stream: false, ...body }),
      });
    } catch (err) {
      throw new Error(
        `Cannot reach Ollama at ${this.cfg.ollamaUrl}. Is it running? (${
          err instanceof Error ? err.message : String(err)
        })`,
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

  chatWithTools(messages: LlmMessage[], tools: WebMcpTool[]): Promise<LlmMessage> {
    return this.postChat({ messages, tools: toOllamaTools(tools) });
  }

  chatJson(messages: LlmMessage[], _responseConstraint?: JSONSchema): Promise<LlmMessage> {
    // Ollama forces JSON with format:"json" (schema is enforced via the prompt).
    return this.postChat({ messages, format: "json" });
  }
}
