---
name: gallery-page-llm
description: Add server-side LLM features to a Gallery HTML/React artifact with Gallery.llm — streaming chat, page context, multi-turn messages, client-side tool loops, JSON Schema structured output, cancellation, retries, and token-budget-aware UX. Load whenever an artifact calls an LLM.
---

# Gallery Page LLM

`Gallery.llm` proxies an OpenAI-compatible chat model configured by the server
owner. **The API key never reaches the artifact** — never ask for it, hardcode
one, or call a third-party LLM from the page instead.

Requirements: the server has `LLM_BASE_URL` + `LLM_API_KEY` configured, and the
share has `llmEnabled` (optionally `llmModel`, `llmDailyTokenBudget`). Always
check `await Gallery.getCapabilities()` → `caps.llm` and show a disabled state
when unavailable.

## Plain streaming chat

```js
const result = await Gallery.llm.chat({
  prompt: userInput,
  context: JSON.stringify(currentPageData),   // optional grounding, keep it small
  onDelta: (delta) => appendToBubble(delta),  // NDJSON-streamed text deltas
  signal: abortController.signal,
});
// result: { text, model, usage, finishReason }
```

`Gallery.llm.ask(prompt, { context? })` is the legacy single-shot text helper.

## Multi-turn and structured output

```js
await Gallery.llm.chat({
  messages: [
    { role: "system", content: "You summarize shared notes as strict JSON." },
    ...history,                 // { role, content, toolCallId?, toolCalls? }
    { role: "user", content: input },
  ],
  responseSchema: {             // JSON Schema → non-streaming, result.json
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  },
});
```

With `responseSchema`, read `result.json` (validated structure) rather than
parsing `result.text` yourself; still handle refusal/truncation gracefully.

## Client-side tools

```js
await Gallery.llm.chat({
  prompt: "Mark the milk todo as done",
  tools: [{
    name: "toggle_todo",
    description: "Toggle a shared todo by id",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async ({ id }) => {
      const snap = await store.update((d) => toggle(d, id));
      return { ok: true, version: snap.version };   // JSON-serializable result
    },
  }],
});
```

Tool results are fed back automatically and the loop continues, up to **6
rounds**. Keep tool results small, validate `args` inside `execute` (the model
can emit anything), and make mutations idempotent where possible. Tools or
`responseSchema` switch the upstream call to non-streaming, so `onDelta` may not
fire — design the loading state accordingly.

## Limits and UX

- Concurrency: ≤2 active calls per share, ≤1 per visitor. Disable the send
  button while a call is active; expect 429s on busy public pages.
- Tokens: output tokens are reserved up front; cancelled/aborted streams still
  consume partial usage against the share's rolling 24h budget. Show a friendly
  "budget exhausted, try later" state instead of retry loops.
- Retries: `retries` (≤3) only helps with recoverable upstream errors. Provide an
  explicit Stop button wired to `AbortController`, and a Retry that resends the
  last user message rather than duplicating side effects.
- Privacy: anything in `prompt`/`messages`/`context` goes to the configured
  third-party model. Send the minimum context needed; warn before including
  visitor-private data, and never include secrets.
- Errors carry `code`/`status` (`Gallery.Error`) — branch on them (quota,
  disabled, conflict) instead of string-matching messages.
