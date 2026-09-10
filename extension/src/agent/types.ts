/**
 * Shared type definitions used across the side panel, service worker,
 * content script, and page bridge.
 */

/* ------------------------------------------------------------------ */
/* WebMCP                                                              */
/* ------------------------------------------------------------------ */

/** A JSON Schema object describing a tool's input. */
export type JSONSchema = Record<string, unknown>;

/**
 * A WebMCP tool descriptor, as returned by document.modelContext.getTools().
 * We keep only the fields we can safely serialize across message boundaries.
 * (The live object also has a non-serializable `window` reference which we drop.)
 */
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  title?: string;
  origin?: string;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
    consequentialHint?: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Messaging: side panel <-> service worker                            */
/* ------------------------------------------------------------------ */

export type PanelToWorkerMessage =
  | { type: "RUN_AGENT"; tabId: number; prompt: string }
  | { type: "LIST_TOOLS"; tabId: number }
  | { type: "CANCEL_AGENT" }
  /**
   * The user's answer to a `confirm_tool` request. `id` matches the request's
   * id; `approved` is true to allow the consequential tool call, false to skip.
   */
  | { type: "CONFIRM_TOOL"; id: string; approved: boolean };

/** A single event emitted while the agent runs, streamed to the panel log. */
export type AgentEvent =
  | { kind: "user_prompt"; text: string }
  | { kind: "tools_discovered"; tools: WebMcpTool[] }
  | { kind: "model_request"; step: number; note: string }
  | { kind: "tool_call"; step: number; tool: string; args: unknown }
  | { kind: "tool_result"; step: number; tool: string; result: string }
  /**
   * The agent is about to call a tool flagged with `consequentialHint` (a
   * high-stakes or non-reversible action). The panel must show a prompt and
   * reply with a CONFIRM_TOOL message carrying the same `id`. The agent loop
   * blocks until it receives that reply.
   */
  | { kind: "confirm_tool"; id: string; step: number; tool: string; title?: string; description?: string; args: unknown }
  | { kind: "final"; message: string }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string }
  /**
   * Result of an out-of-band tool listing (LIST_TOOLS), used to populate the
   * "Tools" tab. `available` is false when the page has no WebMCP support or
   * the content script could not be reached.
   */
  | { kind: "tools_list"; available: boolean; tools: WebMcpTool[]; error?: string };

/* ------------------------------------------------------------------ */
/* Messaging: content script <-> page bridge (MAIN world)              */
/* ------------------------------------------------------------------ */

export type BridgeRequest =
  | { source: "webmcp-agent"; direction: "request"; id: string; op: "getTools" }
  | {
      source: "webmcp-agent";
      direction: "request";
      id: string;
      op: "executeTool";
      toolName: string;
      /** Arguments as a JSON string, per document.modelContext.executeTool. */
      argsJson: string;
    }
  // Chrome Prompt API (LanguageModel) lives in the page's main world, so we
  // reach it through the same bridge we already use for WebMCP.
  | { source: "webmcp-agent"; direction: "request"; id: string; op: "promptAvailability" }
  | {
      source: "webmcp-agent";
      direction: "request";
      id: string;
      op: "prompt";
      prompt: string;
      /** Optional JSON Schema passed as responseConstraint for structured output. */
      responseConstraint?: JSONSchema;
    };

export type BridgeResponse =
  | {
      source: "webmcp-agent";
      direction: "response";
      id: string;
      ok: true;
      tools?: WebMcpTool[];
      result?: string;
      /** For promptAvailability: the raw availability string. */
      availability?: string;
      /** For prompt: the model's text response. */
      text?: string;
    }
  | {
      source: "webmcp-agent";
      direction: "response";
      id: string;
      ok: false;
      error: string;
    };

/* ------------------------------------------------------------------ */
/* Messaging: service worker <-> content script                        */
/* ------------------------------------------------------------------ */

export type WorkerToContentMessage =
  | { type: "WEBMCP_GET_TOOLS" }
  | { type: "WEBMCP_EXECUTE_TOOL"; toolName: string; argsJson: string }
  | { type: "PROMPT_AVAILABILITY" }
  | { type: "PROMPT_RUN"; prompt: string; responseConstraint?: JSONSchema };

export type ContentReply =
  | { ok: true; tools?: WebMcpTool[]; result?: string; availability?: string; text?: string }
  | { ok: false; error: string };
