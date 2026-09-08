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
  | { type: "CANCEL_AGENT" };

/** A single event emitted while the agent runs, streamed to the panel log. */
export type AgentEvent =
  | { kind: "user_prompt"; text: string }
  | { kind: "tools_discovered"; tools: WebMcpTool[] }
  | { kind: "model_request"; step: number; note: string }
  | { kind: "tool_call"; step: number; tool: string; args: unknown }
  | { kind: "tool_result"; step: number; tool: string; result: string }
  | { kind: "final"; message: string }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string };

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
    };

export type BridgeResponse =
  | {
      source: "webmcp-agent";
      direction: "response";
      id: string;
      ok: true;
      tools?: WebMcpTool[];
      result?: string;
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
  | { type: "WEBMCP_EXECUTE_TOOL"; toolName: string; argsJson: string };

export type ContentReply =
  | { ok: true; tools?: WebMcpTool[]; result?: string }
  | { ok: false; error: string };
