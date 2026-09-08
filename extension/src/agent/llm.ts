/**
 * LLM provider abstraction.
 *
 * The agent loop talks to a model only through this interface, so swapping
 * Ollama <-> Chrome Prompt API (or any future backend) requires no changes to
 * agent.ts. Both providers return the SAME message shape (LlmMessage), which
 * means the tool-call contract is identical regardless of backend.
 *
 * Design note: a single `generate(prompt): string` method would be too thin for
 * this agent — the loop needs multi-turn history and (for Ollama) native
 * tool_calls. So the interface exposes two chat methods plus availability:
 *   - chatWithTools: native tool calling (may be unsupported -> throws)
 *   - chatJson:      strict-JSON protocol (works with any text model)
 *   - isAvailable:   pre-flight check so the UI can warn instead of crashing
 */
import type { JSONSchema, WebMcpTool } from "./types";

/** Provider-agnostic chat message (superset of what each backend needs). */
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Native tool calls (Ollama native mode only). */
  tool_calls?: LlmToolCall[];
  /** For role: "tool" — the tool this result belongs to. */
  tool_name?: string;
}

export interface LlmToolCall {
  function: {
    name: string;
    /** Arguments as a parsed object. */
    arguments: Record<string, unknown>;
  };
}

export interface LlmProvider {
  /** Human-readable name for logs/UI. */
  readonly label: string;

  /**
   * Whether this backend supports native tool calling. When false (or omitted
   * as false), the agent uses the JSON protocol exclusively. Defaults to
   * treating `undefined` the same as the provider's own capability.
   */
  readonly supportsNativeTools?: boolean;

  /** True if this backend can be used right now (server up / API present). */
  isAvailable(): Promise<{ ok: boolean; detail?: string }>;

  /**
   * Native tool-calling chat. Providers that don't support native tools should
   * throw; the agent will fall back to chatJson in "auto" mode.
   */
  chatWithTools(messages: LlmMessage[], tools: WebMcpTool[]): Promise<LlmMessage>;

  /**
   * Strict-JSON chat. `responseConstraint` is an optional JSON Schema the
   * provider may use to force structured output (Chrome Prompt API supports
   * this natively; Ollama uses format:"json").
   */
  chatJson(messages: LlmMessage[], responseConstraint?: JSONSchema): Promise<LlmMessage>;
}
