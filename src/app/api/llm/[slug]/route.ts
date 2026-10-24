import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Share } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import {
  callLlm,
  getLlmUsageToday,
  recordUsage,
  releaseLlmCapacity,
  reserveLlmCapacity,
  type LlmCallResult,
  type LlmMessage,
} from "@/lib/shares/llm";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const VISITOR_KEY_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

type Access = { share: Share; actorKey: string | null } | { response: NextResponse };

async function resolveAccess(slug: string, request: NextRequest): Promise<Access> {
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") return { response: json({ error: "不可用", code: "not_found" }, 404) };
  if (access.status === "locked") return { response: json({ error: "请先输入分享访问密码", code: "locked" }, 403) };
  if (!access.share.llmEnabled) return { response: json({ error: "LLM 未启用", code: "not_enabled" }, 404) };
  const raw = request.headers.get("x-gallery-visitor-key");
  const visitorKey = raw && VISITOR_KEY_REGEX.test(raw) ? raw : null;
  return { share: access.share, actorKey: access.user ? `user:${access.user.id}` : visitorKey };
}

const toolCallSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  arguments: z.unknown(),
  rawArguments: z.string().max(32 * 1024),
}).strict();
const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(32 * 1024),
  toolCallId: z.string().max(100).optional(),
  toolCalls: z.array(toolCallSchema).max(8).optional(),
}).strict();
const toolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().min(1).max(1000),
  parameters: z.record(z.string(), z.unknown()),
}).strict();
const postSchema = z.object({
  prompt: z.string().min(1).max(8192).optional(),
  messages: z.array(messageSchema).min(1).max(24).optional(),
  context: z.string().max(32 * 1024).optional(),
  stream: z.boolean().default(false),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(toolSchema).max(8).optional(),
}).strict();

function resultPayload(result: LlmCallResult, share: Share) {
  return {
    text: result.text,
    model: result.model,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls,
    usage: { tokensIn: result.tokensIn, tokensOut: result.tokensOut, ...getLlmUsageToday(share) },
  };
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  if (!isValidOrigin(request)) return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  const { slug } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;
  const env = getEnv();
  if (!env.llm) return json({ error: "服务端未配置 LLM", code: "not_configured" }, 503);
  const ip = await getClientIp();
  if (!rateLimit(`llm:${ip}:${access.share.id}`, 10, 60_000)) {
    return json({ error: "调用过于频繁", code: "rate_limited" }, 429);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ error: "请求必须使用 JSON", code: "invalid_content_type" }, 415);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 160 * 1024) {
    return json({ error: "请求过大", code: "prompt_too_large" }, 413);
  }
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "JSON 格式不正确", code: "invalid_json" }, 400); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success || (!parsed.data.prompt && !parsed.data.messages)) {
    return json({ error: "参数不正确", code: "invalid_request" }, 400);
  }
  const messages: LlmMessage[] = parsed.data.messages ?? [{
    role: "user",
    content: parsed.data.context
      ? `上下文（来自该 Artifact，仅供参考）：\n${parsed.data.context}\n\n---\n\n${parsed.data.prompt!}`
      : parsed.data.prompt!,
  }];
  if (parsed.data.context && parsed.data.messages) {
    messages.push({ role: "user", content: `页面上下文：\n${parsed.data.context}` });
  }
  if (Buffer.byteLength(messages.map((message) => message.content).join("\n")) > 96 * 1024) {
    return json({ error: "对话上下文过大", code: "prompt_too_large" }, 413);
  }

  const actorKey = access.actorKey ?? `ip:${ip}`;
  const reservation = reserveLlmCapacity(access.share, actorKey);
  if ("error" in reservation) {
    return json({ error: reservation.error, code: reservation.code, usage: getLlmUsageToday(access.share) }, 429);
  }
  const streaming = parsed.data.stream && !parsed.data.tools?.length && !parsed.data.responseSchema;
  if (streaming) {
    const encoder = new TextEncoder();
    const callController = new AbortController();
    const abort = () => callController.abort();
    if (request.signal.aborted) abort();
    request.signal.addEventListener("abort", abort, { once: true });
    let released = false;
    let closed = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseLlmCapacity(reservation);
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        };
        try {
          const result = await callLlm(access.share, {
            messages,
            signal: callController.signal,
            onDelta: (delta) => send({ type: "delta", delta }),
          });
          if ("code" in result) {
            if (result.tokensIn || result.tokensOut) {
              recordUsage(access.share.id, access.actorKey, result.tokensIn ?? 0, result.tokensOut ?? 0);
            }
            send({ type: "error", error: { code: result.code, message: result.message } });
          } else {
            recordUsage(access.share.id, access.actorKey, result.tokensIn, result.tokensOut);
            send({ type: "done", result: resultPayload(result, access.share) });
          }
        } catch {
          send({ type: "error", error: { code: "upstream_error", message: "生成失败" } });
        } finally {
          release();
          request.signal.removeEventListener("abort", abort);
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      },
      cancel() {
        closed = true;
        callController.abort();
        release();
        request.signal.removeEventListener("abort", abort);
      },
    });
    return new Response(stream, { headers: { ...NO_STORE_HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" } });
  }

  try {
    const result = await callLlm(access.share, {
      messages,
      responseSchema: parsed.data.responseSchema,
      tools: parsed.data.tools,
      signal: request.signal,
    });
    if ("code" in result) {
      if (result.tokensIn || result.tokensOut) {
        recordUsage(access.share.id, access.actorKey, result.tokensIn ?? 0, result.tokensOut ?? 0);
      }
      const status = result.code === "not_configured" ? 503 : result.code === "aborted" ? 499 : result.code === "quota_exceeded" ? 429 : 502;
      return json({ error: result.message, code: result.code }, status);
    }
    recordUsage(access.share.id, access.actorKey, result.tokensIn, result.tokensOut);
    return json(resultPayload(result, access.share));
  } finally {
    releaseLlmCapacity(reservation);
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;
  return json(getLlmUsageToday(access.share));
}
