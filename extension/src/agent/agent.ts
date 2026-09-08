/**
 * The agent loop. This is the heart of the demo and is intentionally explicit
 * so you can read the entire control flow in one place.
 *
 *   user prompt
 *     -> discover WebMCP tools (from the current tab)
 *     -> LLM decides: tool call OR final answer
 *          tool call -> VALIDATE -> execute WebMCP tool -> feed result back -> loop
 *          final     -> return message
 *     -> hard stop after cfg.maxSteps iterations
 *
 * Security invariants enforced here:
 *   - The model may only call a tool whose name is in the freshly-discovered
 *     tool list for the current page.
 *   - Arguments must be valid JSON (object).
 *   - We NEVER eval, NEVER touch the DOM, and NEVER run model-authored code.
 *     Execution happens only through document.modelContext.executeTool.
 */
import type { AgentConfig } from "../config";
import type { AgentEvent, WebMcpTool } from "./types";
import {
  chatJsonMode,
  chatWithTools,
  type OllamaMessage,
} from "./ollama";

/** Callbacks the caller (service worker) provides to bridge to the page + UI. */
export interface AgentDeps {
  getTools: () => Promise<WebMcpTool[]>;
  executeTool: (toolName: string, argsJson: string) => Promise<string>;
  emit: (event: AgentEvent) => void;
}

/* ---- Prompt building ---------------------------------------------------- */

function systemPrompt(): string {
  return [
    "You are a browser automation agent.",
    "You can call tools that the current web page exposes via WebMCP.",
    "Only use the tools provided to you. Never invent tools or arguments.",
    "You are in a loop and should break the user's request into steps.",
    "If a task needs several actions, call the tools ONE STEP AT A TIME:",
    "after you see a tool's result, decide whether another tool call is needed to fully satisfy the request, and if so make it.",
    "You may also request multiple independent tool calls at once when they do not depend on each other.",
    "Only when the ENTIRE request is complete, respond with a short final message and no tool call.",
    "Do not stop early if part of the request is still unfulfilled.",
  ].join(" ");
}

/** System prompt for the JSON fallback protocol. */
function jsonSystemPrompt(tools: WebMcpTool[]): string {
  const toolLines = tools
    .map((t) => `- ${t.name}: ${t.description} | inputSchema: ${JSON.stringify(t.inputSchema)}`)
    .join("\n");
  return [
    "You are a browser automation agent that can call tools exposed by the current web page.",
    "You MUST reply with a single JSON object and nothing else.",
    "To call a tool, reply exactly:",
    '{"type":"tool_call","tool":"<toolName>","arguments":{ ... }}',
    "You are in a loop: call tools ONE AT A TIME. After each tool result you will be asked again;",
    "if the request needs more actions, reply with the next tool_call.",
    "Only when the ENTIRE request is complete, reply exactly:",
    '{"type":"final","message":"<short message to the user>"}',
    "Do not finish early if part of the request is still unfulfilled.",
    "Only use tools from this list. Never invent tools or arguments:",
    toolLines || "(no tools available)",
  ].join("\n");
}

/* ---- Validation --------------------------------------------------------- */

function parseArgs(raw: unknown): { ok: true; json: string; value: object } | { ok: false; error: string } {
  // Accept either an object (native path) or a JSON string (fallback path).
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return { ok: false, error: "Tool arguments are not valid JSON." };
    }
  }
  if (value == null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Tool arguments must be a JSON object." };
  }
  return { ok: true, json: JSON.stringify(value), value: value as object };
}

function findTool(tools: WebMcpTool[], name: string): WebMcpTool | undefined {
  return tools.find((t) => t.name === name);
}

/* ---- The loop ----------------------------------------------------------- */

export async function runAgent(
  cfg: AgentConfig,
  userPrompt: string,
  deps: AgentDeps,
): Promise<void> {
  deps.emit({ kind: "user_prompt", text: userPrompt });

  // 1. Discover tools on the current page.
  const tools = await deps.getTools();
  deps.emit({ kind: "tools_discovered", tools });

  if (tools.length === 0) {
    deps.emit({
      kind: "info",
      message:
        "No WebMCP tools found on this page. The model will answer without tools.",
    });
  }

  // Decide the initial strategy. "auto" tries native first.
  let useJsonFallback = cfg.toolMode === "json";

  const messages: OllamaMessage[] = [
    { role: "system", content: useJsonFallback ? jsonSystemPrompt(tools) : systemPrompt() },
    { role: "user", content: userPrompt },
  ];

  for (let step = 1; step <= cfg.maxSteps; step++) {
    deps.emit({
      kind: "model_request",
      step,
      note: useJsonFallback ? "structured-JSON mode" : "native tool-calling mode",
    });

    // 2. Ask the model.
    let reply: OllamaMessage;
    try {
      reply = useJsonFallback
        ? await chatJsonMode(cfg, messages)
        : await chatWithTools(cfg, messages, tools);
    } catch (err) {
      // In "auto" mode, a native failure downgrades to JSON and retries once.
      if (cfg.toolMode === "auto" && !useJsonFallback) {
        deps.emit({
          kind: "info",
          message: `Native tool calling failed (${err instanceof Error ? err.message : err}). Falling back to structured-JSON mode.`,
        });
        useJsonFallback = true;
        messages[0] = { role: "system", content: jsonSystemPrompt(tools) };
        step--; // retry this step in fallback mode
        continue;
      }
      deps.emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    // 3a. NATIVE PATH: model returned one or more structured tool_calls.
    if (!useJsonFallback && reply.tool_calls && reply.tool_calls.length > 0) {
      // Record the assistant turn (with all its tool_calls) for context.
      messages.push({ role: "assistant", content: reply.content ?? "", tool_calls: reply.tool_calls });

      // Execute EVERY tool call the model requested in this step
      // (models may batch several independent calls together).
      for (const call of reply.tool_calls) {
        const toolName = call.function.name;
        const parsed = parseArgs(call.function.arguments);
        const executed = await executeValidated(tools, toolName, parsed, step, deps);
        messages.push({ role: "tool", tool_name: toolName, content: executed });
      }
      // Loop again so the model can decide whether more steps are needed.
      continue;
    }

    // 3b. NATIVE PATH: model gave a plain answer (no tool call).
    if (!useJsonFallback) {
      // In auto mode, if the model produced no tool call AND tools exist AND
      // this is the first step, it may not support tools well. But a plain
      // answer is a legitimate final response, so we accept it.
      const finalMsg = reply.content?.trim() || "(no message)";
      deps.emit({ kind: "final", message: finalMsg });
      return;
    }

    // 3c. FALLBACK PATH: parse the strict JSON protocol.
    const decision = parseJsonDecision(reply.content ?? "");
    if (!decision.ok) {
      deps.emit({ kind: "error", message: decision.error });
      return;
    }

    messages.push({ role: "assistant", content: reply.content ?? "" });

    if (decision.value.type === "final") {
      deps.emit({ kind: "final", message: decision.value.message });
      return;
    }

    // tool_call
    const parsed = parseArgs(decision.value.arguments ?? {});
    const executed = await executeValidated(tools, decision.value.tool, parsed, step, deps);
    messages.push({
      role: "user",
      content: `Tool "${decision.value.tool}" returned:\n${executed}\nContinue, or reply with a final message.`,
    });
  }

  // Reached the step limit. Ask the model once for a plain final summary
  // (no tools) so the user still gets a coherent answer instead of a bare stop.
  deps.emit({
    kind: "info",
    message: `Reached the step limit (${cfg.maxSteps}). Asking the model to summarize.`,
  });
  try {
    messages.push({
      role: "user",
      content:
        "You have reached the maximum number of tool steps. Do not call any more tools. " +
        "Reply with a short final message summarizing what was done and what remains, if anything.",
    });
    const summary = await chatJsonMode(cfg, messages).catch(() => chatWithTools(cfg, messages, []));
    const text = summary.content?.trim();
    deps.emit({ kind: "final", message: text || "Reached the step limit before finishing the request." });
  } catch {
    deps.emit({ kind: "final", message: "Reached the step limit before finishing the request." });
  }
}

/* ---- Helpers ------------------------------------------------------------ */

/** Validate a tool call against the live tool list, then execute it. */
async function executeValidated(
  tools: WebMcpTool[],
  toolName: string,
  parsed: ReturnType<typeof parseArgs>,
  step: number,
  deps: AgentDeps,
): Promise<string> {
  // Security check 1: tool must exist on the current page.
  const tool = findTool(tools, toolName);
  if (!tool) {
    const msg = `Refused: "${toolName}" is not an available WebMCP tool on this page.`;
    deps.emit({ kind: "error", message: msg });
    return msg;
  }

  // Security check 2: arguments must be valid JSON object.
  if (!parsed.ok) {
    deps.emit({ kind: "error", message: `${parsed.error} (tool: ${toolName})` });
    return parsed.error;
  }

  deps.emit({ kind: "tool_call", step, tool: toolName, args: parsed.value });

  try {
    const result = await deps.executeTool(toolName, parsed.json);
    deps.emit({ kind: "tool_result", step, tool: toolName, result });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.emit({ kind: "error", message: `Tool "${toolName}" failed: ${msg}` });
    return `Error: ${msg}`;
  }
}

type JsonDecision =
  | { type: "tool_call"; tool: string; arguments?: unknown }
  | { type: "final"; message: string };

function parseJsonDecision(content: string): { ok: true; value: JsonDecision } | { ok: false; error: string } {
  const text = content.trim();
  // Be forgiving: extract the first {...} block if the model added prose.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch {
    return { ok: false, error: `Model did not return valid JSON:\n${content}` };
  }
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, error: "Model JSON was not an object." };
  }
  const rec = obj as Record<string, unknown>;
  if (rec.type === "final") {
    return { ok: true, value: { type: "final", message: String(rec.message ?? "") } };
  }
  if (rec.type === "tool_call" && typeof rec.tool === "string") {
    return { ok: true, value: { type: "tool_call", tool: rec.tool, arguments: rec.arguments } };
  }
  return { ok: false, error: `Unrecognized decision shape: ${slice}` };
}
