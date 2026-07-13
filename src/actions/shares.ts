"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { shares, type Share } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/current-user";
import { hashPassword } from "@/lib/auth/password";
import { deleteFile } from "@/lib/storage";

export type ShareActionResult = { error?: string };

// 业务失败（无权/参数错）返回给客户端展示；所有 action 都必须先过这道 owner 校验
async function findOwnedShare(
  shareId: string,
): Promise<{ share: Share } | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const share = getDb().select().from(shares).where(eq(shares.id, shareId)).get();
  if (!share || share.ownerId !== user.id) return { error: "分享不存在或无权操作" };
  return { share };
}

export async function setSharePassword(
  shareId: string,
  password: string,
): Promise<ShareActionResult> {
  const found = await findOwnedShare(shareId);
  if ("error" in found) return found;
  if (!password || password.length > 200) return { error: "密码不能为空" };

  const passwordHash = await hashPassword(password);
  getDb()
    .update(shares)
    .set({
      passwordHash,
      passwordVersion: sql`${shares.passwordVersion} + 1`,
    })
    .where(eq(shares.id, shareId))
    .run();
  revalidatePath("/dashboard");
  return {};
}

export async function removeSharePassword(
  shareId: string,
): Promise<ShareActionResult> {
  const found = await findOwnedShare(shareId);
  if ("error" in found) return found;

  getDb()
    .update(shares)
    .set({
      passwordHash: null,
      passwordVersion: sql`${shares.passwordVersion} + 1`,
    })
    .where(eq(shares.id, shareId))
    .run();
  revalidatePath("/dashboard");
  return {};
}

/** expiresAt 为 unix 毫秒；null 表示清除过期时间 */
export async function setShareExpiry(
  shareId: string,
  expiresAt: number | null,
): Promise<ShareActionResult> {
  const found = await findOwnedShare(shareId);
  if ("error" in found) return found;
  if (expiresAt !== null) {
    if (!Number.isFinite(expiresAt)) return { error: "时间格式不正确" };
    if (expiresAt <= Date.now()) return { error: "过期时间必须晚于现在" };
  }

  getDb()
    .update(shares)
    .set({ expiresAt })
    .where(eq(shares.id, shareId))
    .run();
  revalidatePath("/dashboard");
  return {};
}

export async function deleteShare(shareId: string): Promise<ShareActionResult> {
  const found = await findOwnedShare(shareId);
  if ("error" in found) return found;

  // 先删 DB 行（此后链接立即 404），文件删除失败只记日志
  getDb().delete(shares).where(eq(shares.id, shareId)).run();
  await deleteFile(shareId);
  revalidatePath("/dashboard");
  return {};
}
