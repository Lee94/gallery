import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Share } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import {
  getPageStateSnapshot,
  savePageState,
} from "@/lib/shares/page-state";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const BODY_WRAPPER_LIMIT = 16 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function notFound(): NextResponse {
  return json({ error: "页面数据不可用", code: "not_found" }, 404);
}

// Content-Length 可以缺失或伪造；流式累计真实字节数，超限立即取消，避免读入任意大 body
async function readBodyWithLimit(
  request: NextRequest,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

type StateAccess = { share: Share } | { response: NextResponse };

async function resolveStateAccess(slug: string): Promise<StateAccess> {
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") return { response: notFound() };
  if (access.status === "locked") {
    return {
      response: json(
        { error: "请先输入分享访问密码", code: "locked" },
        403,
      ),
    };
  }
  // 未启用与不存在统一 404，不把普通 HTML 变成匿名可写存储
  if (!access.share.pageStateEnabled) return { response: notFound() };
  return { share: access.share };
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const access = await resolveStateAccess(slug);
  if ("response" in access) return access.response;

  const ip = await getClientIp();
  if (!rateLimit(`page-state-read:${ip}:${access.share.id}`, 120, 60_000)) {
    return json({ error: "读取过于频繁，请稍后重试", code: "rate_limited" }, 429);
  }

  const snapshot = getPageStateSnapshot(access.share.id);
  return snapshot ? json(snapshot) : notFound();
}

const putBodySchema = z
  .object({
    baseVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    // request JSON 本身已保证 data 是 JSON 值；不再递归遍历，避免恶意深层对象消耗栈
    data: z.unknown(),
  })
  .strict();

export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!isValidOrigin(request)) {
    return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  }

  const { slug } = await ctx.params;
  const access = await resolveStateAccess(slug);
  if ("response" in access) return access.response;

  const ip = await getClientIp();
  if (!rateLimit(`page-state-write:${ip}:${access.share.id}`, 30, 60_000)) {
    return json({ error: "保存过于频繁，请稍后重试", code: "rate_limited" }, 429);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    return json({ error: "请求必须使用 JSON", code: "invalid_content_type" }, 415);
  }

  const maxStateBytes = getEnv().maxPageStateSizeBytes;
  const maxBodyBytes = maxStateBytes + BODY_WRAPPER_LIMIT;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBodyBytes) {
    return json({ error: "页面数据超过大小限制", code: "state_too_large" }, 413);
  }

  let rawBody: string | null;
  try {
    rawBody = await readBodyWithLimit(request, maxBodyBytes);
  } catch {
    return json({ error: "请求体不是合法 UTF-8", code: "invalid_json" }, 400);
  }
  if (rawBody === null) {
    return json({ error: "页面数据超过大小限制", code: "state_too_large" }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "JSON 格式不正确", code: "invalid_json" }, 400);
  }

  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "请求参数不正确", code: "invalid_request" }, 400);
  }

  let dataJson: string | undefined;
  try {
    dataJson = JSON.stringify(parsed.data.data);
  } catch {
    return json({ error: "页面数据无法序列化", code: "invalid_data" }, 400);
  }
  // z.unknown() 允许缺省字段；data 必须显式存在，undefined 不是合法 JSON 值
  if (dataJson === undefined) {
    return json({ error: "缺少页面数据", code: "invalid_request" }, 400);
  }

  const sizeBytes = Buffer.byteLength(dataJson);
  if (sizeBytes > maxStateBytes) {
    return json({ error: "页面数据超过大小限制", code: "state_too_large" }, 413);
  }

  const result = savePageState(
    access.share.id,
    parsed.data.baseVersion,
    dataJson,
    sizeBytes,
  );
  if (result.status === "not_found") return notFound();
  if (result.status === "conflict") {
    return json(
      {
        error: "数据已被其他访客修改",
        code: "version_conflict",
        snapshot: result.snapshot,
      },
      409,
    );
  }
  return json(result.snapshot);
}
