import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Share } from "@/db/schema";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import {
  addComment,
  getComment,
  isVisitorBanned,
  listComments,
} from "@/lib/shares/comments";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const VISITOR_KEY_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_BODY = 2000;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function notFound(msg = "评论不可用"): NextResponse {
  return json({ error: msg, code: "not_found" }, 404);
}

type Access =
  | { share: Share; isOwner: boolean; actorKey: string | null; userLabel: string | null }
  | { response: NextResponse };

async function resolveAccess(
  slug: string,
  request: NextRequest,
): Promise<Access> {
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") return { response: notFound() };
  if (access.status === "locked") {
    return {
      response: json({ error: "请先输入分享访问密码", code: "locked" }, 403),
    };
  }
  if (!access.share.commentsEnabled) {
    return { response: notFound("评论未启用") };
  }
  const raw = request.headers.get("x-gallery-visitor-key");
  const visitorKey =
    raw && VISITOR_KEY_REGEX.test(raw) ? raw : null;
  return {
    share: access.share,
    isOwner: access.isOwner,
    actorKey: access.user ? `user:${access.user.id}` : visitorKey,
    userLabel: access.user?.email.split("@")[0] ?? null,
  };
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;

  const ip = await getClientIp();
  if (!rateLimit(`comments-read:${ip}:${access.share.id}`, 60, 60_000)) {
    return json({ error: "读取过于频繁", code: "rate_limited" }, 429);
  }

  const items = listComments(access.share.id, { includeHidden: access.isOwner });
  return json({ items });
}

const postSchema = z
  .object({
    body: z.string().min(1).max(MAX_BODY),
    authorLabel: z.string().max(40).optional(),
    /** owner 回复某条评论时引用 */
    replyTo: z.string().max(32).optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  if (!isValidOrigin(request)) {
    return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  }
  const { slug } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;

  const ip = await getClientIp();
  if (!rateLimit(`comments-write:${ip}:${access.share.id}`, 5, 60_000)) {
    return json({ error: "评论过于频繁", code: "rate_limited" }, 429);
  }

  // owner 之外的访客必须带合法身份标识、有评论写权限且未被 ban。
  if (!access.isOwner) {
    if (!access.share.commentsVisitorWrite) {
      return json({ error: "该分享仅允许 owner 评论", code: "read_only" }, 403);
    }
    if (!access.actorKey) {
      return json({ error: "缺少访客标识", code: "invalid_visitor_key" }, 400);
    }
    if (isVisitorBanned(access.share.id, access.actorKey)) {
      return json({ error: "已被屏蔽", code: "banned" }, 403);
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON 格式不正确", code: "invalid_json" }, 400);
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "请求参数不正确", code: "invalid_request" }, 400);
  }

  // replyTo 校验（仅 owner 可用作回复标记）
  if (parsed.data.replyTo !== undefined) {
    const target = getComment(access.share.id, parsed.data.replyTo);
    if (!target) {
      return json({ error: "回复的评论不存在", code: "not_found" }, 404);
    }
  }

  const item = addComment({
    shareId: access.share.id,
    visitorKey: access.isOwner ? null : access.actorKey,
    authorLabel: access.isOwner
      ? "站长"
      : (access.userLabel ?? parsed.data.authorLabel ?? "访客"),
    body: parsed.data.body,
    isOwner: access.isOwner,
  });
  return json(item, 201);
}
