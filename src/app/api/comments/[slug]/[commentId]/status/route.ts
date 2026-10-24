import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import { setCommentStatus } from "@/lib/shares/comments";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

const putSchema = z
  .object({ status: z.enum(["open", "resolved", "hidden"]) })
  .strict();

/** owner 管理评论状态（resolve / hide / reopen）。仅 share 所有者可用。 */
export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; commentId: string }> },
) {
  if (!isValidOrigin(request)) {
    return json({ error: "非法请求来源" }, 403);
  }
  const { slug, commentId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return json({ error: "请先登录" }, 401);

  const access = await resolveShareAccess(slug);
  if (access.status !== "ok" || access.share.ownerId !== user.id) {
    return json({ error: "无权操作" }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON 格式不正确" }, 400);
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return json({ error: "参数不正确" }, 400);

  const ok = setCommentStatus(access.share.id, commentId, parsed.data.status);
  return ok ? json({ ok: true }) : json({ error: "评论不存在" }, 404);
}
