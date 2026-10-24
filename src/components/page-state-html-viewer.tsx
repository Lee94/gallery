"use client";

import { useEffect, useRef } from "react";
import { z } from "zod";

const NAMESPACE = "gallery-page-state";
const PROTOCOL_VERSION = 1;
const MAX_IN_FLIGHT = 8;
const VISITOR_KEY_STORAGE = "gallery:visitor-key";

const baseRequest = {
  namespace: z.literal(NAMESPACE),
  version: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(100),
  schemaVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
};

const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    ...baseRequest,
    operation: z.literal("subscribe"),
    types: z
      .array(z.enum(["page-state", "kv", "comments", "version", "attachments", "reset"]))
      .max(6)
      .optional(),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("unsubscribe"),
    subscriptionId: z.string().min(1).max(100),
  }).strict(),
  z.object({ ...baseRequest, operation: z.literal("capabilities") }).strict(),
  z.object({ ...baseRequest, operation: z.literal("get") }).strict(),
  z
    .object({
      ...baseRequest,
      operation: z.literal("save"),
      baseVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      dataJson: z.string(),
    })
    .strict(),
  z
    .object({ ...baseRequest, operation: z.literal("visitor-get") })
    .strict(),
  z
    .object({
      ...baseRequest,
      operation: z.literal("visitor-save"),
      baseVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      dataJson: z.string(),
    })
    .strict(),
  // —— KV ——
  z.object({
    ...baseRequest,
    operation: z.literal("kv-get"),
    collection: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("kv-list"),
    collection: z.string().min(1).max(64),
    prefix: z.string().max(256).optional(),
    cursor: z.string().max(256).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("kv-put"),
    collection: z.string().min(1).max(64),
    key: z.string().min(1).max(256).optional(), // 省略则服务端发
    valueJson: z.string(),
    baseVersion: z.number().int().nonnegative().optional(),
    ifAbsent: z.boolean().optional(),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("kv-del"),
    collection: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
    baseVersion: z.number().int().nonnegative().optional(),
  }).strict(),
  // —— 附件 ——
  z.object({ ...baseRequest, operation: z.literal("attachment-list") }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("attachment-upload"),
    name: z.string().min(1).max(255),
    mimeType: z.string().max(100),
    size: z.number().int().nonnegative(),
    visibility: z.enum(["private", "shared"]),
    data: z.custom<Blob>((value) => typeof Blob !== "undefined" && value instanceof Blob),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("attachment-delete"),
    attachmentId: z.string().min(8).max(64),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("attachment-download"),
    attachmentId: z.string().min(8).max(64),
  }).strict(),
  // —— LLM ——
  z.object({
    ...baseRequest,
    operation: z.literal("llm-cancel"),
    targetRequestId: z.string().min(1).max(100),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("llm-chat"),
    prompt: z.string().min(1).max(8192).optional(),
    messages: z.array(z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string().max(32 * 1024),
      toolCallId: z.string().max(100).optional(),
      toolCalls: z.array(z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(64),
        arguments: z.unknown(),
        rawArguments: z.string().max(32 * 1024),
      }).strict()).max(8).optional(),
    }).strict()).min(1).max(24).optional(),
    context: z.string().max(32 * 1024).optional(),
    responseSchema: z.record(z.string(), z.unknown()).optional(),
    tools: z.array(z.object({
      name: z.string().min(1).max(64),
      description: z.string().min(1).max(1000),
      parameters: z.record(z.string(), z.unknown()),
    }).strict()).max(8).optional(),
  }).strict(),
  z.object({
    ...baseRequest,
    operation: z.literal("llm-ask"),
    prompt: z.string().min(1).max(8192),
    context: z.string().max(32 * 1024).optional(),
  }).strict(),
]);

type BridgeRequest = z.infer<typeof requestSchema>;

type Props = {
  rawUrl: string;
  slug: string;
  title: string;
  maxStateBytes: number;
  pageStateEnabled: boolean;
  visitorStateEnabled: boolean;
  kvEnabled: boolean;
  attachmentsEnabled: boolean;
  maxAttachmentBytes: number;
  llmEnabled: boolean;
  dataGeneration: number;
  dataSchemaVersion: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function postError(
  port: MessagePort,
  requestId: string,
  code: string,
  message: string,
  status = 0,
  snapshot?: unknown,
) {
  port.postMessage({
    namespace: NAMESPACE,
    version: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message, status },
    ...(snapshot === undefined ? {} : { snapshot }),
  });
}

/** 每个浏览器一个稳定 visitorKey，存父页面 localStorage。子页面拿不到 key 本身。 */
function getOrCreateVisitorKey(): string {
  try {
    const existing = window.localStorage.getItem(VISITOR_KEY_STORAGE);
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) return existing;
    const key = window.crypto.randomUUID();
    window.localStorage.setItem(VISITOR_KEY_STORAGE, key);
    return key;
  } catch {
    // localStorage 不可用（隐私模式/禁用）：退回会话内随机 key，刷新后变人
    return window.crypto.randomUUID();
  }
}

export function PageStateHtmlViewer({
  rawUrl,
  slug,
  title,
  maxStateBytes,
  pageStateEnabled,
  visitorStateEnabled,
  kvEnabled,
  attachmentsEnabled,
  maxAttachmentBytes,
  llmEnabled,
  dataGeneration,
  dataSchemaVersion,
}: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const ports = new Set<MessagePort>();
    const subscriptions = new Map<string, { port: MessagePort; types: Set<string> | null }>();
    const requestControllers = new Map<string, AbortController>();
    const encoder = new TextEncoder();
    const visitorKey = visitorStateEnabled || kvEnabled || llmEnabled || attachmentsEnabled
      ? getOrCreateVisitorKey()
      : null;
    let disposed = false;
    let events: EventSource | null = null;
    let activeDataGeneration = dataGeneration;
    let activeDataSchemaVersion = dataSchemaVersion;

    const dataHeaders = (schemaVersion?: number): Record<string, string> => ({
      "X-Gallery-Data-Generation": String(activeDataGeneration),
      ...(schemaVersion === undefined
        ? {}
        : { "X-Gallery-Data-Schema-Version": String(schemaVersion) }),
    });

    const ensureEvents = () => {
      if (events) return;
      events = new EventSource(`/api/events/${encodeURIComponent(slug)}`);
      const forward = (type: string) => (message: MessageEvent<string>) => {
        let detail: unknown;
        try {
          detail = JSON.parse(message.data);
        } catch {
          return;
        }
        const record = asRecord(detail);
        if (typeof record?.dataGeneration === "number") {
          activeDataGeneration = record.dataGeneration;
        }
        if (typeof record?.dataSchemaVersion === "number") {
          activeDataSchemaVersion = record.dataSchemaVersion;
        }
        const payload = {
          namespace: NAMESPACE,
          version: PROTOCOL_VERSION,
          event: {
            id: Number(message.lastEventId),
            type,
            ...(asRecord(detail) ?? {}),
          },
        };
        for (const subscription of subscriptions.values()) {
          if (subscription.types && !subscription.types.has(type)) continue;
          subscription.port.postMessage(payload);
        }
      };
      for (const type of ["page-state", "kv", "comments", "version", "attachments", "reset"]) {
        events.addEventListener(type, forward(type));
      }
    };

    async function handle(request: BridgeRequest, port: MessagePort, requestController: AbortController) {
      try {
        const op = request.operation;
        if (op === "llm-cancel") {
          requestControllers.get(request.targetRequestId)?.abort();
          port.postMessage({ namespace: NAMESPACE, version: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: { cancelled: true } });
          return;
        }
        if (op === "unsubscribe") {
          const subscription = subscriptions.get(request.subscriptionId);
          if (subscription) {
            subscriptions.delete(request.subscriptionId);
            subscription.port.close();
          }
          if (subscriptions.size === 0) {
            events?.close();
            events = null;
          }
          port.postMessage({
            namespace: NAMESPACE,
            version: PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result: { unsubscribed: Boolean(subscription) },
          });
          return;
        }
        if (op === "capabilities") {
          port.postMessage({
            namespace: NAMESPACE,
            version: PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              pageState: pageStateEnabled,
              visitorState: visitorStateEnabled,
              kv: kvEnabled,
              attachments: attachmentsEnabled,
              llm: llmEnabled,
              dataGeneration: activeDataGeneration,
              dataSchemaVersion: activeDataSchemaVersion,
            },
          });
          return;
        }
        const isVisitorOp = op === "visitor-get" || op === "visitor-save";
        const isKvOp = op.startsWith("kv-");
        const isAttachmentOp = op.startsWith("attachment-");
        const isLlmOp = op === "llm-ask" || op === "llm-chat";

        // 通道未启用时拒绝：防子页面在未授权的 share 上探测接口
        if (isVisitorOp && !visitorStateEnabled) {
          postError(port, request.requestId, "not_enabled", "访客数据未启用");
          return;
        }
        if (!isVisitorOp && !isKvOp && !isAttachmentOp && !isLlmOp && !pageStateEnabled) {
          postError(port, request.requestId, "not_enabled", "共享数据未启用");
          return;
        }
        if (isKvOp && !kvEnabled) {
          postError(port, request.requestId, "not_enabled", "行集数据未启用");
          return;
        }
        if (isAttachmentOp && !attachmentsEnabled) {
          postError(port, request.requestId, "not_enabled", "附件未启用");
          return;
        }
        if (isLlmOp && !llmEnabled) {
          postError(port, request.requestId, "not_enabled", "LLM 未启用");
          return;
        }

        // —— KV 分支：直接转发到 /api/kv/<slug>/<collection>[/<key>] ——
        if (isKvOp && "collection" in request) {
          const coll = encodeURIComponent(request.collection);
          let url = `/api/kv/${encodeURIComponent(slug)}/${coll}`;
          let method = "GET";
          let body: string | undefined;

          if (op === "kv-get" || op === "kv-del") {
            url += `/${request.key!.split("/").map(encodeURIComponent).join("/")}`;
            if (op === "kv-del") {
              method = "DELETE";
              if (request.baseVersion !== undefined) {
                url += `?baseVersion=${request.baseVersion}`;
              }
            }
          } else if (op === "kv-list") {
            const qs = new URLSearchParams();
            if (request.prefix) qs.set("prefix", request.prefix);
            if (request.cursor) qs.set("cursor", request.cursor);
            if (request.limit) qs.set("limit", String(request.limit));
            const q = qs.toString();
            if (q) url += `?${q}`;
          } else if (op === "kv-put") {
            method = "PUT";
            if (request.key !== undefined) {
              url += `/${request.key.split("/").map(encodeURIComponent).join("/")}`;
            }
            const payload: Record<string, unknown> = {
              value: JSON.parse(request.valueJson),
            };
            if (request.baseVersion !== undefined) payload.baseVersion = request.baseVersion;
            if (request.ifAbsent !== undefined) payload.ifAbsent = request.ifAbsent;
            body = JSON.stringify(payload);
          }

          const headers: Record<string, string> = {
            Accept: "application/json",
            ...dataHeaders(request.schemaVersion),
          };
          if (body) headers["Content-Type"] = "application/json";
          if (visitorKey) headers["X-Gallery-Visitor-Key"] = visitorKey;
          const res = await fetch(url, {
            method,
            headers,
            body,
            credentials: "same-origin",
            cache: "no-store",
            signal: requestController.signal,
          });
          const respBody: unknown = await res.json().catch(() => null);
          if (res.ok) {
            port.postMessage({
              namespace: NAMESPACE,
              version: PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              result: respBody,
            });
            return;
          }
          const record = asRecord(respBody);
          postError(
            port,
            request.requestId,
            typeof record?.code === "string" ? record.code : "http_error",
            typeof record?.error === "string" ? record.error : "行集请求失败",
            res.status,
            record?.item ?? record?.snapshot,
          );
          return;
        }

        // —— 附件分支：Blob 只在桥接消息中传输，服务端存储名不下发给子页面 ——
        if (isAttachmentOp) {
          const endpoint = `/api/attachments/${encodeURIComponent(slug)}`;
          let url = endpoint;
          let method = "GET";
          let body: FormData | undefined;
          if (op === "attachment-delete" || op === "attachment-download") {
            url += `/${encodeURIComponent(request.attachmentId)}`;
            if (op === "attachment-delete") method = "DELETE";
          } else if (op === "attachment-upload") {
            if (request.data.size !== request.size || request.size > maxAttachmentBytes) {
              postError(port, request.requestId, "file_too_large", "附件大小不正确或超过限制", 413);
              return;
            }
            method = "POST";
            body = new FormData();
            body.set("visibility", request.visibility);
            body.set("file", new File([request.data], request.name, { type: request.mimeType }));
          }
          const headers: Record<string, string> = {
            Accept: op === "attachment-download" ? "application/octet-stream" : "application/json",
            ...dataHeaders(request.schemaVersion),
          };
          if (visitorKey) headers["X-Gallery-Visitor-Key"] = visitorKey;
          const response = await fetch(url, {
            method,
            headers,
            body,
            credentials: "same-origin",
            cache: "no-store",
            signal: requestController.signal,
          });
          if (response.ok && op === "attachment-download") {
            const data = await response.arrayBuffer();
            port.postMessage({
              namespace: NAMESPACE,
              version: PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              result: { data, mimeType: response.headers.get("content-type") },
            }, [data]);
            return;
          }
          const responseBody: unknown = await response.json().catch(() => null);
          if (response.ok) {
            port.postMessage({
              namespace: NAMESPACE,
              version: PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              result: responseBody,
            });
            return;
          }
          const record = asRecord(responseBody);
          postError(
            port,
            request.requestId,
            typeof record?.code === "string" ? record.code : "http_error",
            typeof record?.error === "string" ? record.error : "附件请求失败",
            response.status,
          );
          return;
        }

        // —— 多轮 / 流式 / 工具调用 LLM ——
        if (op === "llm-chat") {
          if (!request.prompt && !request.messages) {
            postError(port, request.requestId, "invalid_request", "缺少 prompt 或 messages");
            return;
          }
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson, application/json",
          };
          if (visitorKey) headers["X-Gallery-Visitor-Key"] = visitorKey;
          const response = await fetch(`/api/llm/${encodeURIComponent(slug)}`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              prompt: request.prompt,
              messages: request.messages,
              context: request.context,
              responseSchema: request.responseSchema,
              tools: request.tools,
              stream: true,
            }),
            credentials: "same-origin",
            cache: "no-store",
            signal: requestController.signal,
          });
          if (!response.ok) {
            const errorBody: unknown = await response.json().catch(() => null);
            const record = asRecord(errorBody);
            postError(port, request.requestId, typeof record?.code === "string" ? record.code : "http_error", typeof record?.error === "string" ? record.error : "LLM 调用失败", response.status);
            return;
          }
          if (response.headers.get("content-type")?.includes("application/x-ndjson") && response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (!line) continue;
                const event = asRecord(JSON.parse(line));
                if (event?.type === "delta" && typeof event.delta === "string") {
                  port.postMessage({ namespace: NAMESPACE, version: PROTOCOL_VERSION, requestId: request.requestId, delta: event.delta });
                } else if (event?.type === "done") {
                  port.postMessage({ namespace: NAMESPACE, version: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result: event.result });
                  return;
                } else if (event?.type === "error") {
                  const error = asRecord(event.error);
                  postError(port, request.requestId, typeof error?.code === "string" ? error.code : "upstream_error", typeof error?.message === "string" ? error.message : "生成失败");
                  return;
                }
              }
            }
            postError(port, request.requestId, "bridge_unavailable", "LLM 数据流提前结束");
            return;
          }
          const result: unknown = await response.json();
          port.postMessage({ namespace: NAMESPACE, version: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result });
          return;
        }

        // —— LLM 分支 ——
        if (isLlmOp && request.operation === "llm-ask") {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
          };
          if (visitorKey) headers["X-Gallery-Visitor-Key"] = visitorKey;
          const res = await fetch(`/api/llm/${encodeURIComponent(slug)}`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              prompt: request.prompt,
              ...(request.context !== undefined ? { context: request.context } : {}),
            }),
            credentials: "same-origin",
            cache: "no-store",
            signal: requestController.signal,
          });
          const respBody: unknown = await res.json().catch(() => null);
          if (res.ok) {
            port.postMessage({
              namespace: NAMESPACE,
              version: PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              result: respBody,
            });
            return;
          }
          const record = asRecord(respBody);
          postError(
            port,
            request.requestId,
            typeof record?.code === "string" ? record.code : "http_error",
            typeof record?.error === "string" ? record.error : "LLM 调用失败",
            res.status,
          );
          return;
        }

        // —— 原有 page-state / visitor-state 分支 ——
        const isSave = op === "save" || op === "visitor-save";

        let init: RequestInit;
        if (!isSave) {
          init = {
            headers: {
              Accept: "application/json",
              ...dataHeaders(request.schemaVersion),
            },
          };
        } else {
          if (encoder.encode(request.dataJson).byteLength > maxStateBytes) {
            postError(
              port,
              request.requestId,
              "state_too_large",
              "页面数据超过大小限制",
              413,
            );
            return;
          }
          try {
            JSON.parse(request.dataJson);
          } catch {
            postError(port, request.requestId, "invalid_data", "页面数据不是合法 JSON");
            return;
          }

          init = {
            method: "PUT",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...dataHeaders(request.schemaVersion),
            },
            body: `{"baseVersion":${request.baseVersion},"data":${request.dataJson}}`,
          };
        }

        const endpoint = isVisitorOp
          ? `/api/visitor-state/${encodeURIComponent(slug)}`
          : `/api/page-state/${encodeURIComponent(slug)}`;
        const headers = new Headers(init.headers);
        if (isVisitorOp && visitorKey) {
          headers.set("X-Gallery-Visitor-Key", visitorKey);
        }
        const response = await fetch(endpoint, {
          ...init,
          headers,
          credentials: "same-origin",
          cache: "no-store",
          signal: requestController.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (response.ok) {
          port.postMessage({
            namespace: NAMESPACE,
            version: PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            snapshot: body,
          });
          return;
        }

        const record = asRecord(body);
        postError(
          port,
          request.requestId,
          typeof record?.code === "string" ? record.code : "http_error",
          typeof record?.error === "string" ? record.error : "共享数据请求失败",
          response.status,
          record?.snapshot,
        );
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        postError(
          port,
          request.requestId,
          "bridge_unavailable",
          "无法连接共享数据服务，请稍后重试",
        );
      }
    }

    const onMessage = (event: MessageEvent) => {
      // slug 由父页面固定；source 校验防止其他 frame/window 借父页面身份读写
      if (event.source !== frame.contentWindow || event.ports.length !== 1) return;
      const port = event.ports[0]!;
      const parsed = requestSchema.safeParse(event.data);
      if (!parsed.success) {
        const data = asRecord(event.data);
        postError(
          port,
          typeof data?.requestId === "string" ? data.requestId : "",
          "invalid_request",
          "共享数据请求格式不正确",
        );
        port.close();
        return;
      }
      if (parsed.data.operation === "subscribe") {
        if (subscriptions.size >= MAX_IN_FLIGHT || subscriptions.has(parsed.data.requestId)) {
          postError(port, parsed.data.requestId, "too_many_requests", "事件订阅过多", 429);
          port.close();
          return;
        }
        subscriptions.set(parsed.data.requestId, {
          port,
          types: parsed.data.types ? new Set(parsed.data.types) : null,
        });
        port.start();
        port.postMessage({
          namespace: NAMESPACE,
          version: PROTOCOL_VERSION,
          requestId: parsed.data.requestId,
          ok: true,
          result: { subscribed: true },
        });
        ensureEvents();
        return;
      }
      if (ports.size >= MAX_IN_FLIGHT && parsed.data.operation !== "llm-cancel") {
        postError(
          port,
          parsed.data.requestId,
          "too_many_requests",
          "待处理的共享数据请求过多",
          429,
        );
        port.close();
        return;
      }

      ports.add(port);
      port.start();
      const requestController = new AbortController();
      requestControllers.set(parsed.data.requestId, requestController);
      void handle(parsed.data, port, requestController).finally(() => {
        requestControllers.delete(parsed.data.requestId);
        ports.delete(port);
        port.close();
      });
    };

    window.addEventListener("message", onMessage);
    // 等桥接监听器就绪后再加载上传内容，避免子页面的首个 get 在 hydration 前丢失
    frame.src = rawUrl;

    return () => {
      disposed = true;
      for (const requestController of requestControllers.values()) requestController.abort();
      requestControllers.clear();
      events?.close();
      window.removeEventListener("message", onMessage);
      for (const port of ports) port.close();
      for (const subscription of subscriptions.values()) subscription.port.close();
      ports.clear();
      subscriptions.clear();
    };
  }, [
    maxStateBytes,
    rawUrl,
    slug,
    pageStateEnabled,
    visitorStateEnabled,
    kvEnabled,
    attachmentsEnabled,
    maxAttachmentBytes,
    llmEnabled,
    dataGeneration,
    dataSchemaVersion,
  ]);

  return (
    <iframe
      ref={frameRef}
      // 与 raw 响应头一致：绝不因共享存储而开放 allow-same-origin
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
      allowFullScreen
      className="w-full flex-1 border-0 bg-white"
      title={title}
    />
  );
}
