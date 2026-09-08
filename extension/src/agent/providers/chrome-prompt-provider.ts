/**
 * ChromePromptApiProvider — LlmProvider backed by Chrome's built-in
 * LanguageModel (Prompt API / Gemini Nano).
 *
 * The LanguageModel global lives in the page's MAIN world, not in the service
 * worker, so this provider does not call it directly. Instead it delegates to a
 * `tabCall` function (supplied by the service worker) that routes requests
 * through the existing page bridge.
 *
 * Prompt API has no native tool-calling, so:
 *   - chatWithTools() throws -> in "auto" mode the agent falls back to chatJson.
 *   - chatJson() flattens the message history into one prompt string and uses
 *     responseConstraint (JSON Schema) for structured output when provided.
 *
 * The returned LlmMessage always has role "assistant" and puts the model text
 * in `content`, so the agent's JSON-protocol parser handles it identically to
 * Ollama's JSON mode. The tool-call contract is unchanged.
 */
import type { JSONSchema, WebMcpTool } from "../types";
import type { LlmMessage, LlmProvider } from "../llm";

/** How the provider reaches the Prompt API in the page (via the tab bridge). */
export interface PromptTabCall {
  availability(): Promise<string>;
  prompt(input: string, responseConstraint?: JSONSchema): Promise<string>;
}

export class ChromePromptApiProvider implements LlmProvider {
  readonly label = "Chrome Prompt API";
  readonly supportsNativeTools = false;

  constructor(private readonly tab: PromptTabCall) {}

  async isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const availability = await this.tab.availability();
      // LanguageModel.availability() returns e.g. "available",
      // "downloadable", "downloading", or "unavailable".
      if (availability === "available") {
        return { ok: true, detail: "LanguageModel is available." };
      }
      if (availability === "downloadable" || availability === "downloading") {
        return {
          ok: false,
          detail: `Model is "${availability}". It must finish downloading before use.`,
        };
      }
      return {
        ok: false,
        detail:
          `Chrome Prompt API reports "${availability}". ` +
          "Use a Chrome build with the built-in AI / Prompt API enabled.",
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // Prompt API has no native tool calling. Throwing here lets the agent's
  // "auto" mode fall back to the JSON protocol.
  chatWithTools(_messages: LlmMessage[], _tools: WebMcpTool[]): Promise<LlmMessage> {
    return Promise.reject(
      new Error("Chrome Prompt API does not support native tool calling; use JSON mode."),
    );
  }

  async chatJson(messages: LlmMessage[], responseConstraint?: JSONSchema): Promise<LlmMessage> {
    const prompt = flattenMessages(messages);
    const text = await this.tab.prompt(prompt, responseConstraint);
    return { role: "assistant", content: text ?? "" };
  }
}

/**
 * Flatten a chat message array into a single prompt string. Prompt API's
 * session.prompt() takes one string, so we render roles as labeled blocks.
 */
function flattenMessages(messages: LlmMessage[]): string {
  return messages
    .map((m) => {
      const label =
        m.role === "system"
          ? "SYSTEM"
          : m.role === "user"
            ? "USER"
            : m.role === "tool"
              ? `TOOL RESULT${m.tool_name ? ` (${m.tool_name})` : ""}`
              : "ASSISTANT";
      return `${label}:\n${m.content}`;
    })
    .join("\n\n");
}
