import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "gallery-llm-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-only-session-secret-with-at-least-32-characters";
process.env.LLM_BASE_URL = "https://llm.example.test";
process.env.LLM_API_KEY = "test-key";
execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: process.cwd(), env: process.env, stdio: "pipe" });

const modules = (async () => {
  const [{ getDb }, schema, create, llm] = await Promise.all([
    import("../src/db/index"),
    import("../src/db/schema"),
    import("../src/lib/shares/create"),
    import("../src/lib/shares/llm"),
  ]);
  return { getDb, schema, create, llm };
})();
const shareReady = modules.then(async ({ getDb, schema, create }) => {
  getDb().insert(schema.users).values({
    id: "llm-owner",
    email: "llm@example.test",
    passwordHash: "unused",
    role: "user",
    createdAt: Date.now(),
  }).run();
  const content = new TextEncoder().encode("<!doctype html><h1>LLM</h1>");
  const created = await create.createShare({
    ownerId: "llm-owner",
    filename: "index.html",
    content,
    size: content.length,
    llmEnabled: true,
  });
  return created.share;
});
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
});

test("流式 LLM 解析 SSE 增量、结束原因和用量", async () => {
  const [share, { llm }] = await Promise.all([shareReady, modules]);
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.stream_options.include_usage, true);
    return new Response([
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2},"choices":[]}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  };
  const deltas: string[] = [];
  const result = await llm.callLlm(share, {
    messages: [{ role: "user", content: "hi" }],
    onDelta: (delta) => deltas.push(delta),
  });
  assert.ok(!("code" in result));
  assert.deepEqual(deltas, ["Hello ", "world"]);
  assert.equal(result.text, "Hello world");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.tokensIn, 3);
  assert.equal(result.tokensOut, 2);
});

test("结构化输出和 tool_calls 保持 OpenAI 兼容字段", async () => {
  const [share, { llm }] = await Promise.all([shareReady, modules]);
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, false);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.tools[0].function.name, "get_weather");
    return Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
  };
  const result = await llm.callLlm(share, {
    messages: [{ role: "user", content: "weather" }],
    responseSchema: { type: "object" },
    tools: [{ name: "get_weather", description: "查询天气", parameters: { type: "object" } }],
  });
  assert.ok(!("code" in result));
  assert.equal(result.toolCalls[0]?.id, "call-1");
  assert.deepEqual(result.toolCalls[0]?.arguments, { city: "Paris" });
  assert.equal(result.toolCalls[0]?.rawArguments, '{"city":"Paris"}');
});

test("上游错误和取消不会泄漏为未捕获异常，取消返回部分用量", async () => {
  const [share, { llm }] = await Promise.all([shareReady, modules]);
  globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
  const failed = await llm.callLlm(share, { messages: [{ role: "user", content: "hi" }] });
  assert.ok("code" in failed);
  assert.equal(failed.code, "upstream_error");
  assert.equal(failed.status, 503);

  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const pending = llm.callLlm(share, {
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
    onDelta() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const aborted = await pending;
  assert.ok("code" in aborted);
  assert.equal(aborted.code, "aborted");
  assert.ok((aborted.tokensIn ?? 0) > 0);
  assert.ok((aborted.tokensOut ?? 0) > 0);
});

test("LLM 并发预留限制同访客并保留其他访客容量", async () => {
  const [share, { llm }] = await Promise.all([shareReady, modules]);
  const first = llm.reserveLlmCapacity(share, "visitor-a");
  assert.ok(!("error" in first));
  assert.ok("error" in llm.reserveLlmCapacity(share, "visitor-a"));
  const second = llm.reserveLlmCapacity(share, "visitor-b");
  assert.ok(!("error" in second));
  assert.ok("error" in llm.reserveLlmCapacity(share, "visitor-c"));
  llm.releaseLlmCapacity(first);
  llm.releaseLlmCapacity(second);
  const availableAgain = llm.reserveLlmCapacity(share, "visitor-c");
  assert.ok(!("error" in availableAgain));
  llm.releaseLlmCapacity(availableAgain);
  const third = llm.reserveLlmCapacity(share, "visitor-d");
  if (!("error" in third)) llm.releaseLlmCapacity(third);
  const lingering = llm.reserveLlmCapacity(share, "visitor-e");
  if (!("error" in lingering)) llm.releaseLlmCapacity(lingering);
});
