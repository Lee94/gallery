"use client";

import { useEffect, useRef } from "react";
import { z } from "zod";

const NAMESPACE = "gallery-page-state";
const PROTOCOL_VERSION = 1;
const MAX_IN_FLIGHT = 8;

const baseRequest = {
  namespace: z.literal(NAMESPACE),
  version: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1).max(100),
};

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ ...baseRequest, operation: z.literal("get") }).strict(),
  z
    .object({
      ...baseRequest,
      operation: z.literal("save"),
      baseVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      // 子页面传 JSON 文本而非结构化对象，避免循环对象/深层对象触发递归校验
      dataJson: z.string(),
    })
    .strict(),
]);

type BridgeRequest = z.infer<typeof requestSchema>;

type Props = {
  rawUrl: string;
  slug: string;
  title: string;
  maxStateBytes: number;
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

export function PageStateHtmlViewer({ rawUrl, slug, title, maxStateBytes }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const controller = new AbortController();
    const ports = new Set<MessagePort>();
    const encoder = new TextEncoder();
    let disposed = false;

    async function handle(request: BridgeRequest, port: MessagePort) {
      try {
        let init: RequestInit;
        if (request.operation === "get") {
          init = { headers: { Accept: "application/json" } };
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
            // 只验证它是一个完整 JSON 值；构造请求时仍保留文本，避免深度 stringify
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
            },
            body: `{"baseVersion":${request.baseVersion},"data":${request.dataJson}}`,
          };
        }

        const response = await fetch(`/api/page-state/${encodeURIComponent(slug)}`, {
          ...init,
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
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
      if (ports.size >= MAX_IN_FLIGHT) {
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
      void handle(parsed.data, port).finally(() => {
        ports.delete(port);
        port.close();
      });
    };

    window.addEventListener("message", onMessage);
    // 等桥接监听器就绪后再加载上传内容，避免子页面的首个 get 在 hydration 前丢失
    frame.src = rawUrl;

    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener("message", onMessage);
      for (const port of ports) port.close();
      ports.clear();
    };
  }, [maxStateBytes, rawUrl, slug]);

  return (
    <iframe
      ref={frameRef}
      // 与 raw 响应头一致：绝不因共享存储而开放 allow-same-origin
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
      className="w-full flex-1 border-0 bg-white"
      title={title}
    />
  );
}
