/**
 * GeminiApiProvider — LlmProvider backed by Google's Gemini API (cloud).
 *
 * Uses the REST generateContent endpoint with an API key. Supports native
 * function calling, mapped to/from our LlmMessage shape so the agent loop is
 * unchanged.
 *
 * CLOUD PROVIDER: prompts and WebMCP tool descriptions are sent to Google.
 * The API key is read from config (entered in the UI, never hard-coded).
 *
 * Model fallback: if the configured model returns 404 / NOT_FOUND, the provider
 * retries down GEMINI_FALLBACK_MODELS (newest first) and remembers the first
 * one that works for the rest of the session.
 */
import type { AgentConfig } from "../../config";
import { GEMINI_FALLBACK_MODELS } from "../../config";
import type { JSONSchema, WebMcpTool } from "../types";
import type { LlmMessage, LlmProvider, LlmToolCall } from "../llm";

/* ---- Gemini REST shapes (only what we use) ------------------------------ */

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /** Gemini 3 reasoning token; must be echoed back verbatim on the next turn. */
  thoughtSignature?: string;
}

interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: { content?: GeminiContent }[];
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiApiProvider implements LlmProvider {
  readonly label = "Gemini (cloud)";
  readonly supportsNativeTools = true;

  /** Resolved working model (set after the first successful call). */
  private resolvedModel: string | null = null;

  constructor(private readonly cfg: AgentConfig) {}

  /** Ordered list of models to try: configured first, then the fallback chain. */
  private get candidateModels(): string[] {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const m of [this.cfg.geminiModel, ...GEMINI_FALLBACK_MODELS]) {
      if (m && !seen.has(m)) {
        seen.add(m);
        list.push(m);
      }
    }
    return list;
  }

  async isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.cfg.apiKey.trim()) {
      return { ok: false, detail: "No Gemini API key set. Enter one in the panel config." };
    }
    return { ok: true, detail: `Cloud provider — prompts are sent to Google. Model: ${this.cfg.geminiModel}.` };
  }

  chatWithTools(messages: LlmMessage[], tools: WebMcpTool[]): Promise<LlmMessage> {
    return this.generate(messages, tools);
  }

  chatJson(messages: LlmMessage[], responseConstraint?: JSONSchema): Promise<LlmMessage> {
    // No tools -> the model answers directly; we still ask for JSON via schema.
    return this.generate(messages, [], responseConstraint);
  }

  /* ---- Core request with model fallback --------------------------------- */

  private async generate(
    messages: LlmMessage[],
    tools: WebMcpTool[],
    responseConstraint?: JSONSchema,
  ): Promise<LlmMessage> {
    if (!this.cfg.apiKey.trim()) throw new Error("No Gemini API key set.");

    const models = this.resolvedModel ? [this.resolvedModel] : this.candidateModels;
    const body = this.buildRequestBody(messages, tools, responseConstraint);

    let lastErr = "";
    for (const model of models) {
      try {
        const message = await this.postGenerateContent(model, body);
        this.resolvedModel = model; // remember what worked
        return message;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastErr = msg;
        // Only fall through on "model not found / not supported"; other errors
        // (bad key, quota) are terminal and re-thrown immediately.
        if (!/not\s*found|NOT_FOUND|404|not supported|unsupported/i.test(msg)) {
          throw err;
        }
        // else: try the next model in the chain
      }
    }
    throw new Error(`No usable Gemini model. Last error: ${lastErr}`);
  }

  private async postGenerateContent(
    model: string,
    body: Record<string, unknown>,
  ): Promise<LlmMessage> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.cfg.apiKey.trim() },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Cannot reach Gemini API (${err instanceof Error ? err.message : String(err)}).`);
    }

    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok || data.error) {
      const e = data.error;
      throw new Error(`Gemini API ${e?.status ?? res.status}: ${e?.message ?? res.statusText}`);
    }

    return parseCandidate(data);
  }

  /* ---- Request/response mapping ----------------------------------------- */

  private buildRequestBody(
    messages: LlmMessage[],
    tools: WebMcpTool[],
    responseConstraint?: JSONSchema,
  ): Record<string, unknown> {
    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const body: Record<string, unknown> = {
      contents: toGeminiContents(messages),
    };

    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map(toFunctionDeclaration) }];
    } else if (responseConstraint) {
      // Structured JSON output when we're not using function calling.
      body.generationConfig = {
        responseMimeType: "application/json",
        responseSchema: responseConstraint,
      };
    }

    return body;
  }
}

/* ---- Pure mapping helpers ----------------------------------------------- */

function toFunctionDeclaration(t: WebMcpTool): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description || t.name,
    parameters:
      t.inputSchema && typeof t.inputSchema === "object"
        ? t.inputSchema
        : { type: "object", properties: {} },
  };
}

function toGeminiContents(messages: LlmMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // handled via systemInstruction
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.tool_name ?? "tool",
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      contents.push({
        role: "model",
        parts: m.tool_calls.map((c) => {
          const part: GeminiPart = {
            functionCall: { name: c.function.name, args: c.function.arguments },
          };
          // Gemini 3 requires the original thoughtSignature echoed back verbatim.
          if (c.signature) part.thoughtSignature = c.signature;
          return part;
        }),
      });
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  return contents;
}

function parseCandidate(data: GeminiResponse): LlmMessage {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: LlmToolCall[] = [];
  let text = "";

  for (const p of parts) {
    if (p.functionCall) {
      toolCalls.push({
        function: { name: p.functionCall.name, arguments: p.functionCall.args ?? {} },
        // Preserve the reasoning token so we can echo it back next turn.
        signature: p.thoughtSignature,
      });
    } else if (typeof p.text === "string") {
      text += p.text;
    }
  }

  const message: LlmMessage = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}
