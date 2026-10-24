import { NextResponse, type NextRequest } from "next/server";
import type { Share } from "@/db/schema";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import { checkDataCompatibility } from "@/lib/shares/data-compatibility";
import {
  getAccessibleAttachment,
  listAttachments,
  releaseAttachment,
  reserveAttachment,
  toAttachmentView,
} from "@/lib/shares/attachments";
import { deleteAttachment, readAttachment, saveAttachment } from "@/lib/storage";
import { getEnv } from "@/lib/env";

type Access = { share: Share; isOwner: boolean; actorKey: string } | { response: NextResponse };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function resolveAccess(slug: string, request: NextRequest): Promise<Access> {
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") return { response: json({ error: "附件不可用", code: "not_found" }, 404) };
  if (access.status === "locked") {
    return { response: json({ error: "请先输入分享访问密码", code: "locked" }, 403) };
  }
  if (!access.share.attachmentsEnabled) {
    return { response: json({ error: "附件未启用", code: "not_found" }, 404) };
  }
  const incompatible = checkDataCompatibility(request.headers, access.share);
  if (incompatible) return { response: json(incompatible.body, incompatible.status) };
  const rawVisitorKey = request.headers.get("x-gallery-visitor-key");
  const visitorKey = rawVisitorKey && /^[a-zA-Z0-9_-]{8,64}$/.test(rawVisitorKey)
    ? rawVisitorKey
    : null;
  const actorKey = access.user ? `user:${access.user.id}` : visitorKey;
  if (!actorKey) return { response: json({ error: "缺少访客标识", code: "invalid_visitor_key" }, 400) };
  return { share: access.share, isOwner: access.isOwner, actorKey };
}

function attachmentResponse(content: Uint8Array, name: string, mimeType: string): Response {
  const fallback = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "attachment";
  return new Response(content as BodyInit, {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Content-Length": String(content.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  const { slug, path } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;
  if (!path || path.length === 0) {
    return json({ items: listAttachments(access.share.id, access.actorKey, access.isOwner) });
  }
  if (path.length !== 1) return json({ error: "附件不存在", code: "not_found" }, 404);
  const item = getAccessibleAttachment(access.share.id, path[0]!, access.actorKey, access.isOwner);
  if (!item) return json({ error: "附件不存在", code: "not_found" }, 404);
  try {
    return attachmentResponse(await readAttachment(item.id), item.originalName, item.mimeType);
  } catch {
    return json({ error: "附件文件不可用", code: "not_found" }, 404);
  }
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  if (!isValidOrigin(request)) return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  const { slug, path } = await ctx.params;
  if (path && path.length > 0) return json({ error: "附件不存在", code: "not_found" }, 404);
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;
  const ip = await getClientIp();
  if (!rateLimit(`attachment-write:${ip}:${access.share.id}`, 12, 60_000)) {
    return json({ error: "上传过于频繁", code: "rate_limited" }, 429);
  }
  const maxBody = getEnv().attachmentLimits.fileBytes + 1024 * 1024;
  if (Number(request.headers.get("content-length") ?? 0) > maxBody) {
    return json({ error: "附件超过大小限制", code: "file_too_large" }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "上传格式不正确", code: "invalid_request" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "缺少附件", code: "invalid_request" }, 400);
  const visibility = form.get("visibility") === "shared" ? "shared" : "private";
  const originalName = (file.name || "attachment")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 255) || "attachment";
  const mimeType = /^[\x20-\x7e]{1,100}$/.test(file.type) ? file.type : "application/octet-stream";
  const reserved = reserveAttachment({
    shareId: access.share.id,
    creatorKey: access.actorKey,
    originalName,
    mimeType,
    sizeBytes: file.size,
    visibility,
  });
  if ("error" in reserved) return json({ error: reserved.error, code: "quota_exceeded" }, reserved.status);
  try {
    await saveAttachment(reserved.id, new Uint8Array(await file.arrayBuffer()));
  } catch {
    releaseAttachment(access.share.id, reserved.id);
    return json({ error: "附件保存失败", code: "storage_error" }, 500);
  }
  return json(toAttachmentView(reserved, access.actorKey, access.isOwner), 201);
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  if (!isValidOrigin(request)) return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  const { slug, path } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;
  if (!path || path.length !== 1) return json({ error: "附件不存在", code: "not_found" }, 404);
  const item = getAccessibleAttachment(access.share.id, path[0], access.actorKey, access.isOwner);
  if (!item) return json({ error: "附件不存在", code: "not_found" }, 404);
  if (!access.isOwner && item.creatorKey !== access.actorKey) {
    return json({ error: "只能删除自己上传的附件", code: "forbidden" }, 403);
  }
  releaseAttachment(access.share.id, item.id);
  await deleteAttachment(item.id);
  return json({ deleted: true });
}
