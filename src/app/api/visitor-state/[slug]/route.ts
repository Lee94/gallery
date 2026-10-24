import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Share } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import { checkDataCompatibility } from "@/lib/shares/data-compatibility";
import {
  getVisitorStateSnapshot,
  saveVisitorState,
} from "@/lib/shares/visitor-state";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const BODY_WRAPPER_LIMIT = 16 * 1024;
// visitorKey 由父页面用 crypto.randomUUID() 生成；限制格式防注入与滥用
const VISITOR_KEY_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function notFound(): NextResponse {
  return json({ error: "访客数据不可用", code: "not_found" }, 404);
}

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

type StateAccess =
  | { share: Share; visitorKey: string }
  | { response: NextResponse };

async function resolveStateAccess(
  slug: string,
  request: NextRequest,
): Promise<StateAccess> {
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
  if (!access.share.visitorStateEnabled) return { response: notFound() };
  const incompatible = checkDataCompatibility(request.headers, access.share);
  if (incompatible) return { response: json(incompatible.body, incompatible.status) };

  const rawVisitorKey = request.headers.get("x-gallery-visitor-key") ?? "";
  if (!access.user && !VISITOR_KEY_REGEX.test(rawVisitorKey)) {
    return {
      response: json(
        { error: "缺少或非法的访客标识", code: "invalid_visitor_key" },
        400,
      ),
    };
  }
  // 登录用户跨设备共用一份私有数据；匿名访客继续使用父页面保存的随机 key。
  const visitorKey = access.user ? `user:${access.user.id}` : rawVisitorKey;
  return { share: access.share, visitorKey };
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const access = await resolveStateAccess(slug, request);
  if ("response" in access) return access.response;

  const ip = await getClientIp();
  if (
    !rateLimit(`visitor-state-read:${ip}:${access.share.id}`, 120, 60_000)
  ) {
    return json({ error: "读取过于频繁，请稍后重试", code: "rate_limited" }, 429);
  }

  const snapshot = getVisitorStateSnapshot(access.share.id, access.visitorKey);
  return snapshot ? json(snapshot) : notFound();
}

const putBodySchema = z
  .object({
    baseVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
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
  const access = await resolveStateAccess(slug, request);
  if ("response" in access) return access.response;

  const ip = await getClientIp();
  if (
    !rateLimit(`visitor-state-write:${ip}:${access.share.id}`, 30, 60_000)
  ) {
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
    return json({ error: "访客数据超过大小限制", code: "state_too_large" }, 413);
  }

  let rawBody: string | null;
  try {
    rawBody = await readBodyWithLimit(request, maxBodyBytes);
  } catch {
    return json({ error: "请求体不是合法 UTF-8", code: "invalid_json" }, 400);
  }
  if (rawBody === null) {
    return json({ error: "访客数据超过大小限制", code: "state_too_large" }, 413);
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
    return json({ error: "访客数据无法序列化", code: "invalid_data" }, 400);
  }
  if (dataJson === undefined) {
    return json({ error: "缺少访客数据", code: "invalid_request" }, 400);
  }

  const sizeBytes = Buffer.byteLength(dataJson);
  if (sizeBytes > maxStateBytes) {
    return json({ error: "访客数据超过大小限制", code: "state_too_large" }, 413);
  }

  const result = saveVisitorState(
    access.share.id,
    access.visitorKey,
    parsed.data.baseVersion,
    dataJson,
    sizeBytes,
  );
  if (result.status === "not_found") return notFound();
  if (result.status === "conflict") {
    return json(
      {
        error: "数据已被修改",
        code: "version_conflict",
        snapshot: result.snapshot,
      },
      409,
    );
  }
  return json(result.snapshot);
}
