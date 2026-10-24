import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const sdkSource = readFileSync(
  new URL("../public/sdk/page-state-v1.js", import.meta.url),
  "utf8",
);

type Port = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: (() => void) | null;
  start(): void;
  close(): void;
};

function loadSdk() {
  let request: { data: Record<string, unknown>; port: MessagePort } | undefined;
  let channelPort: Port | undefined;
  const parent = {
    postMessage(data: Record<string, unknown>, _origin: string, ports: MessagePort[]) {
      request = { data, port: ports[0]! };
    },
  };
  let sequence = 0;
  const window: Record<string, unknown> = {
    parent,
    crypto: { randomUUID: () => `request-${++sequence}` },
  };
  window.window = window;

  class MockMessageChannel {
    port1: Port;
    port2: object;
    constructor() {
      this.port1 = {
        onmessage: null,
        onmessageerror: null,
        start() {},
        close() {},
      };
      this.port2 = {};
      channelPort = this.port1;
    }
  }

  vm.runInNewContext(sdkSource, {
    window,
    MessageChannel: MockMessageChannel,
    setTimeout,
    clearTimeout,
  });

  return {
    window: window as {
      Gallery: {
        getCapabilities(): Promise<Record<string, unknown>>;
        requireDataSchema(version: number): number;
        events: {
          subscribe(
            listener: (event: Record<string, unknown>) => void,
            options?: { types?: string[] },
          ): Promise<() => Promise<unknown>>;
        };
        pageState: unknown;
        visitorState: unknown;
        db: unknown;
        files: unknown;
        llm: {
          chat(options: {
            prompt?: string;
            messages?: Array<Record<string, unknown>>;
            responseSchema?: Record<string, unknown>;
            tools?: Array<{
              name: string;
              description: string;
              parameters: Record<string, unknown>;
              execute(args: unknown, context: unknown): unknown;
            }>;
            retries?: number;
            signal?: AbortSignal;
            onDelta(delta: string): void;
          }): Promise<Record<string, unknown>>;
        };
      };
      GalleryPageState: { connect(): { get(): Promise<unknown> } };
      GalleryVisitorState: unknown;
      GalleryDB: unknown;
      GalleryLLM: unknown;
    },
    getRequest: () => request,
    respond(data: unknown) {
      assert.ok(channelPort?.onmessage);
      channelPort.onmessage({ data });
    },
  };
}

test("统一 Gallery 入口保留全部旧全局别名", () => {
  const { window } = loadSdk();
  assert.equal(window.Gallery.pageState, window.GalleryPageState);
  assert.equal(window.Gallery.visitorState, window.GalleryVisitorState);
  assert.equal(window.Gallery.db, window.GalleryDB);
  assert.equal(window.Gallery.llm, window.GalleryLLM);
});

test("getCapabilities 使用 capabilities 操作并校验响应", async () => {
  const { window, getRequest, respond } = loadSdk();
  const pending = window.Gallery.getCapabilities();
  const request = getRequest();
  assert.equal(request?.data.operation, "capabilities");
  assert.equal(request?.data.namespace, "gallery-page-state");
  assert.equal(request?.data.version, 1);

  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-1",
    ok: true,
    result: {
      protocolVersion: 1,
      pageState: true,
      visitorState: false,
      kv: true,
      attachments: true,
      llm: false,
      dataGeneration: 3,
      dataSchemaVersion: 2,
    },
  });
  const capabilities = await pending;
  assert.equal(capabilities.pageState, true);
  assert.equal(capabilities.visitorState, false);
  assert.equal(capabilities.kv, true);
  assert.equal(capabilities.llm, false);
  assert.equal(capabilities.dataGeneration, 3);
});

test("schema 声明会附加到后续数据请求", async () => {
  const { window, getRequest, respond } = loadSdk();
  assert.equal(window.Gallery.requireDataSchema(2), 2);
  const pending = window.GalleryPageState.connect().get();
  assert.equal(getRequest()?.data.schemaVersion, 2);
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-1",
    ok: true,
    snapshot: { data: null, version: 0, updatedAt: 123 },
  });
  await pending;
});

test("events.subscribe 保持端口订阅事件并可取消", async () => {
  const { window, getRequest, respond } = loadSdk();
  const received: unknown[] = [];
  const pending = window.Gallery.events.subscribe((event) => received.push(event), {
    types: ["kv"],
  });
  assert.equal(getRequest()?.data.operation, "subscribe");
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-1",
    ok: true,
    result: { subscribed: true },
  });
  const unsubscribe = await pending;
  respond({
    namespace: "gallery-page-state",
    version: 1,
    event: { id: 9, type: "kv", collection: "votes", key: "a" },
  });
  assert.equal(received.length, 1);
  assert.equal((received[0] as { id: number }).id, 9);

  const unsubscribed = unsubscribe();
  assert.equal(getRequest()?.data.operation, "unsubscribe");
  assert.equal(getRequest()?.data.subscriptionId, "request-1");
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-2",
    ok: true,
    result: { unsubscribed: true },
  });
  await unsubscribed;
});

test("旧 pageState API 仍走原 get 协议", async () => {
  const { window, getRequest, respond } = loadSdk();
  const pending = window.GalleryPageState.connect().get();
  assert.equal(getRequest()?.data.operation, "get");
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-1",
    ok: true,
    snapshot: { data: { ok: true }, version: 0, updatedAt: 123 },
  });
  const snapshot = (await pending) as { data: { ok: boolean }; version: number };
  assert.equal(snapshot.data.ok, true);
  assert.equal(snapshot.version, 0);
});

test("Gallery.llm.chat 转发增量并解析结构化 JSON", async () => {
  const { window, getRequest, respond } = loadSdk();
  const deltas: string[] = [];
  const pending = window.Gallery.llm.chat({
    prompt: "生成结果",
    responseSchema: { type: "object" },
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(getRequest()?.data.operation, "llm-chat");
  respond({ namespace: "gallery-page-state", version: 1, requestId: "request-1", delta: '{"ok":' });
  respond({ namespace: "gallery-page-state", version: 1, requestId: "request-1", delta: "true}" });
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-1",
    ok: true,
    result: { text: '{"ok":true}', model: "test", finishReason: "stop", toolCalls: [] },
  });
  const result = await pending;
  assert.deepEqual(deltas, ['{"ok":', "true}"]);
  assert.equal((result.json as { ok?: boolean }).ok, true);
});

test("Gallery.llm.chat 的 AbortSignal 会通知父页面取消原请求", async () => {
  const { window, getRequest, respond } = loadSdk();
  const controller = new AbortController();
  const pending = window.Gallery.llm.chat({ prompt: "长时间生成", signal: controller.signal, onDelta() {} });
  const originalRequestId = getRequest()?.data.requestId;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === "aborted");
  assert.equal(getRequest()?.data.operation, "llm-cancel");
  assert.equal(getRequest()?.data.targetRequestId, originalRequestId);
  respond({ namespace: "gallery-page-state", version: 1, requestId: "request-2", ok: true, result: { cancelled: true } });
});

test("Gallery.llm.chat 对上游错误重试且不重放普通错误", async () => {
  const { window, getRequest, respond } = loadSdk();
  const pending = window.Gallery.llm.chat({ prompt: "重试", retries: 1, onDelta() {} });
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-1",
    ok: false,
    error: { code: "upstream_error", message: "临时错误" },
  });
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(getRequest()?.data.requestId, "request-2");
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-2",
    ok: true,
    result: { text: "成功", model: "test", finishReason: "stop", toolCalls: [] },
  });
  assert.equal((await pending).text, "成功");
});

test("Gallery.llm.chat 执行客户端工具并回填 assistant/tool 消息", async () => {
  const { window, getRequest, respond } = loadSdk();
  let executed = 0;
  const pending = window.Gallery.llm.chat({
    prompt: "天气如何",
    onDelta() {},
    tools: [{
      name: "weather",
      description: "查询天气",
      parameters: { type: "object" },
      execute(args) {
        executed += 1;
        assert.deepEqual(args, { city: "Paris" });
        return { temperature: 20 };
      },
    }],
  });
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-1",
    ok: true,
    result: {
      text: "",
      model: "test",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "weather", arguments: { city: "Paris" }, rawArguments: '{"city":"Paris"}' }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executed, 1);
  const second = getRequest();
  assert.equal(second?.data.requestId, "request-2");
  const messages = second?.data.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[2]?.role, "tool");
  assert.equal(messages[2]?.toolCallId, "call-1");
  assert.equal(messages[2]?.content, '{"temperature":20}');
  respond({
    namespace: "gallery-page-state",
    version: 1,
    requestId: "request-2",
    ok: true,
    result: { text: "巴黎 20°C", model: "test", finishReason: "stop", toolCalls: [] },
  });
  assert.equal((await pending).text, "巴黎 20°C");
});
