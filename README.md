# WebMCP Local Agent

A local Chrome extension (Manifest V3) that acts as a small AI agent. You type a
command in natural language into a side panel, e.g.:

> Add a new employee named John Smith

You can pick the LLM backend with one click:

- **Ollama** — local server (native tools + JSON fallback).
- **Chrome Prompt API** — built-in on-device Gemini Nano (JSON mode).
- **Gemini (cloud)** — Google Gemini via API key (native function calling).

The rest of the flow — tool discovery, prompt building, tool selection,
execution — is identical for all three.

The agent then:

1. discovers the **WebMCP** tools exposed by the current tab (`document.modelContext.getTools()`),
2. sends your prompt + the tool list to the **selected LLM provider**,
3. lets the model decide which tool to call and with what arguments,
4. executes that tool in the page (`document.modelContext.executeTool()`),
5. feeds the result back to the model,
6. loops (up to a step limit) if the model wants another tool,
7. shows the final answer.

Everything runs locally. Nothing is published to the Chrome Web Store, and the
only network call is to your local Ollama.

---

## Architecture

WebMCP's `document.modelContext` object only exists in the page's **main world**.
A normal content script runs in an isolated world and cannot see it, so we inject
a tiny main-world "page bridge" that talks to the content script over
`window.postMessage`.

```
 Side Panel  (sidepanel.ts — UI, prompt, log)
     │  chrome.runtime port ("agent")
     ▼
 Service Worker  (service-worker.ts)          ── fetch ──►  Ollama  (localhost:11434)
     │   runs the agent loop (agent.ts + ollama.ts)
     │  chrome.tabs.sendMessage
     ▼
 Content Script  (content-script.ts, isolated world)
     │  window.postMessage
     ▼
 Page Bridge  (page-bridge.ts, MAIN world)
     │
     ▼
 document.modelContext   ← WebMCP
     │
     ▼
 The website's registered tools
```

The agent loop lives in the service worker so it keeps running even when the
panel loses focus, and keeps the Ollama fetch off the UI document.

---

## Project structure

```
webmcp-local-agent/
  build.mjs                 esbuild bundler -> dist/
  package.json
  tsconfig.json
  README.md
  test-page/
    index.html              demo page that registers WebMCP tools (for testing)
  extension/
    manifest.json
    src/
      config.ts             ollamaUrl / model / toolMode / maxSteps + storage
      agent/
        types.ts            shared types + message contracts
        llm.ts              LlmProvider interface + shared message shapes
        agent.ts            the agent loop + validation/security (provider-agnostic)
        providers/
          ollama-provider.ts        Ollama /api/chat backend
          chrome-prompt-provider.ts Chrome LanguageModel backend (via page bridge)
          gemini-provider.ts        Gemini cloud backend (API key + model fallback)
      background/
        service-worker.ts   message routing, tab bridge, runs the loop
      content/
        content-script.ts   isolated-world transport bridge
        page-bridge.ts       MAIN-world WebMCP caller
      sidepanel/
        sidepanel.html
        sidepanel.css
        sidepanel.ts        UI + live log
  dist/                     build output (load this unpacked)
```

---

## Requirements

- **Chrome / Chromium** with the experimental WebMCP flag (see step 7).
- **Node.js** 18+ (to build the extension).
- **Ollama** (local model server).

---

## 1. Install dependencies

```powershell
npm install
```

## 2. Install and run Ollama

Download Ollama from https://ollama.com and install it. After install the server
usually starts on its own (tray icon on Windows) and listens on
`http://localhost:11434`. If it isn't running, start it manually:

```powershell
ollama serve
```

Verify it's up:

```powershell
ollama --version
# server response:
Invoke-WebRequest http://localhost:11434    # -> "Ollama is running"
```

## 3. Pull the recommended model

The recommended model is **`llama3.1`** (8B, ~4.9 GB). It has solid, officially
supported tool calling in Ollama and was tested with this extension — it picks
tools correctly and fills in arguments.

```powershell
ollama pull llama3.1
```

The 4.9 GB download takes a while. When it's done, verify:

```powershell
ollama list        # should show a llama3.1 row
```

Alternatives with good tool calling (optional): `qwen3:8b`, `qwen2.5:7b`.

> Note: very small models (e.g. Gemma 3B variants / `functiongemma`) returned
> empty or malformed tool calls in our testing. For a reliable demo, stick with
> `llama3.1` or a comparable model.

## 4. Configure CORS in Ollama (IMPORTANT)

Ollama checks the `Origin` header. Requests from the extension have a
`chrome-extension://…` origin that is not on the allow-list by default, so
without this step you get **HTTP 403 Forbidden**. Allow any origin:

```powershell
setx OLLAMA_ORIGINS "*"
```

Then **restart Ollama** so it picks up the variable (Quit from the tray and start
again, or restart the service). `setx` persists the variable, so you only do this
once.

> On a local demo machine `*` is fine. To narrow it down you can pass the exact
> `chrome-extension://<EXTENSION_ID>` origin, but that ID changes on every
> "Load unpacked", so `*` is more practical for a demo.

## 5. Choose the model in config

The default model lives in `extension/src/config.ts`:

```ts
export const DEFAULT_CONFIG: AgentConfig = {
  provider: "ollama",         // "ollama" | "chrome" | "gemini"
  ollamaUrl: "http://localhost:11434",
  model: "llama3.1",         // <-- Ollama model
  apiKey: "",                 // Gemini key — set in the UI, never commit
  geminiModel: "gemini-3.8-flash",
  toolMode: "auto",           // "auto" | "native" | "json"
  maxSteps: 5,
};
```

You can also change the model **at runtime** in the side panel: click **config**,
type a model name, and press **Save config** (stored in `chrome.storage.local`,
no rebuild needed). The panel value **overrides** the default from `config.ts`.
If you edit `config.ts`, run the build again.

## 6. Build

```powershell
npm run build
```

This produces the `dist/` folder. (`npm run typecheck` runs the TypeScript
compiler without emitting, if you want to check types separately.)

## 7. Load the extension into Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select the `dist/` folder.

> After every rebuild (`npm run build`), click the **reload** (⟳) icon on the
> extension card. A full reinstall (Remove + Load unpacked) is almost never
> needed.

## 8. Enable the experimental WebMCP flag

In current Chromium/Chrome (and Edge), WebMCP is behind a flag and off by
default.

1. Go to `chrome://flags`.
2. Search for **WebMCP** (it may appear as "Web Model Context" — the name varies
   by version).
3. Enable the flag.
4. Restart the browser.

Quick check on any page in DevTools:

```js
await document.modelContext.getTools();
```

If `document.modelContext` is `undefined`, the flag is off or the page registers
no tools. The panel will tell you this explicitly.

## 9. Open the side panel

Click the extension's toolbar icon — the panel opens on the right. (If it doesn't
open on click in your Chrome version, right-click the icon → **Open side panel**.)

## 10. Test it

### Option A — the included demo page

Serve `test-page/` over http (content scripts and WebMCP don't apply on
`file://`):

```powershell
npx serve test-page
# open the printed http://localhost:xxxx URL
```

The page registers two WebMCP tools: `createEmployee` and `listEmployees`.
Reload the tab after loading the extension, make sure you see the green
"WebMCP tools registered" status, then type in the panel:

> Add a new employee named John Smith

then e.g.:

> Add John Smith and Jane Doe, then list all employees

### Option B — any WebMCP-enabled site

Open a page that registers WebMCP tools, open the panel, and type a
natural-language command.

**What you'll see in the log:** your prompt → discovered WebMCP tools → the tool
call the model chose + arguments → the tool result → the final answer.

### Switching providers (Ollama ↔ Chrome Prompt API)

At the top of the panel, use the **Provider** dropdown:

- **Ollama** — needs `ollama serve` running and a pulled model (steps 2-4).
- **Chrome Prompt API** — needs a Chrome build where
  `await LanguageModel.availability()` returns `"available"`. No Ollama, no URL,
  no model name. Runs entirely on-device.
- **Gemini (cloud)** — open **config**, paste a Gemini API key (from
  [Google AI Studio](https://aistudio.google.com/apikey)), optionally set the
  model (default `gemini-3.8-flash`), and **Save config**. The key is stored in
  `chrome.storage.local` and never leaves your machine except in requests to
  Google's API. **Do not commit a real key.**

Switch, then click **Run** with the same prompt to compare. The agent checks
availability first: if the selected provider isn't ready, you get a clear error
in the log instead of a crash.

> Note: the Chrome provider calls `LanguageModel` **in the page**, so the model
> is only reachable on a normal http(s) tab (not `chrome://`). Reload the tab
> after loading the extension.

---

## LLM providers

Both providers implement one interface (`extension/src/agent/llm.ts`):

```ts
interface LlmProvider {
  label: string;
  supportsNativeTools?: boolean;
  isAvailable(): Promise<{ ok: boolean; detail?: string }>;
  chatWithTools(messages, tools): Promise<LlmMessage>;   // native tool calling
  chatJson(messages, responseConstraint?): Promise<LlmMessage>; // JSON protocol
}
```

- **`OllamaProvider`** (`agent/providers/ollama-provider.ts`) — talks to the
  local Ollama `/api/chat`. Supports native tool calling and JSON mode.
- **`ChromePromptApiProvider`** (`agent/providers/chrome-prompt-provider.ts`) —
  uses Chrome's built-in `LanguageModel` (Gemini Nano). No native tool calling,
  so it always runs the JSON protocol, with `responseConstraint` (JSON Schema)
  for structured output.
- **`GeminiApiProvider`** (`agent/providers/gemini-provider.ts`) — calls the
  Gemini REST `generateContent` endpoint with an API key. Native function
  calling. Defaults to `gemini-3.8-flash` and **falls back** through older Flash
  models (`GEMINI_FALLBACK_MODELS`) if the chosen one isn't available for your
  key. Preserves Gemini 3 **thought signatures** (the opaque reasoning token
  attached to each function call) and echoes them back on the next turn, as the
  API requires for multi-step tool calling. **Cloud provider**: prompts and tool
  descriptions are sent to Google.

The **agent loop is provider-agnostic**: it only calls `chatWithTools` /
`chatJson` and always parses the same contract
(`{type:"tool_call",tool,arguments}` or `{type:"final",message}`).

### Where the provider is chosen

- **UI**: the **Provider** dropdown at the top of the side panel (one-click
  switch, no need to open config). The choice is saved to `chrome.storage.local`.
- **Code**: the service worker reads `cfg.provider` and builds the matching
  provider in `buildProvider()` (`background/service-worker.ts`).

### Why the Prompt API goes through the page bridge

`window.LanguageModel` lives in the page's **main world**, not the service
worker. So the Chrome provider routes its calls through the *same* page bridge we
already use for WebMCP: service worker → content script → page bridge (main
world) → `LanguageModel.create()` / `session.prompt(...)`. No new plumbing.

## How tool calling works

- **Native mode** (Ollama): the tool list is sent in the `tools` field
  (`/api/chat`), and the model replies with `message.tool_calls`. All parallel
  calls in a single response are executed.
- **JSON fallback**: if the model can't do native tools (or you pick `json`), the
  model is asked to reply with strict JSON:

  ```json
  { "type": "tool_call", "tool": "createEmployee", "arguments": { "name": "John Smith" } }
  ```
  or
  ```json
  { "type": "final", "message": "Employee created successfully." }
  ```

- **auto** tries native first and downgrades to JSON on failure.

The agent runs in a loop: after each tool result it returns to the model, which
can call another tool, up to the `maxSteps` limit (default 5).

## Security

The agent can only call tools that the current page actually exposes via WebMCP.
Before every execution it checks:

- the tool name is in the freshly-fetched list from this page,
- the arguments parse as a JSON object.

The agent never runs `eval`, never executes model-authored JavaScript, and never
touches the DOM directly. Execution goes only through
`document.modelContext.executeTool`.

## Memory management (RAM/VRAM)

The model loads into memory only when you send a request and **unloads itself
after ~5 minutes of inactivity** (default `OLLAMA_KEEP_ALIVE`). The Ollama server
itself uses very little in the background. Handy commands:

```powershell
ollama ps                       # what's loaded now (UNTIL column = auto-unload time)
ollama stop llama3.1            # free the memory immediately
$env:OLLAMA_KEEP_ALIVE="60m"    # keep the model loaded longer (e.g. during a demo)
```

For a demo, set a longer `keep_alive` and "warm up" the model with one request
just before you present — the first request loads the model (~10-15s), later ones
are fast.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Cannot reach Ollama…" | `ollama serve` not running, or wrong URL in config. |
| **HTTP 403 Forbidden** | Set `OLLAMA_ORIGINS=*` and restart Ollama (step 4). |
| "model '…' not found" | Wrong model in config/panel. Check `ollama list` and enter the exact name. |
| "WebMCP is not available…" | Enable the WebMCP flag in `chrome://flags`; the page may register no tools. |
| "Chrome Prompt API is not available…" | `LanguageModel` missing — use a Chrome build with built-in AI enabled, on a normal http(s) tab. |
| Chrome provider says model is "downloadable" | The on-device model still needs to finish downloading before use. |
| "No Gemini API key set" | Open config, paste a key from Google AI Studio, Save config. |
| "Gemini API … 400/403" | Bad/expired key or the model isn't enabled for your key; the provider auto-falls-back through older Flash models. |
| "Could not reach the page's content script" | Reload the tab; not available on `chrome://` or the Web Store. |
| Model calls one tool and stops | Phrase the request as multiple steps; or use a stronger model. Weaker models do the minimum. |
| Empty / malformed tool calls | Model too weak for tool calling — use `llama3.1` or `qwen3:8b`. |
