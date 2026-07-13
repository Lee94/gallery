import { desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { shares, type Share } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { deleteFile } from "@/lib/storage";

// 分享的所有权校验 + 变更逻辑，按显式 userId 工作（不依赖 cookies）。
// Server Actions（src/actions/shares.ts）与 MCP 工具（src/lib/mcp/tools.ts）共用同一份，
// 保证两条入口的授权与副作用完全一致。revalidatePath 之类 Next 专属副作用留在 action 层。

export type ShareMutation = { error?: string };

type Found = { share: Share } | { error: string };

// 不存在与非本人所有统一同一句提示（不区分，避免泄露他人分享是否存在）
function findOwned(userId: string, condition: SQL): Found {
  const share = getDb().select().from(shares).where(condition).get();
  if (!share || share.ownerId !== userId) return { error: "分享不存在或无权操作" };
  return { share };
}

export function findOwnedShare(userId: string, shareId: string): Found {
  return findOwned(userId, eq(shares.id, shareId));
}

/** MCP 工具对外只认 slug（公开标识），内部据此解析出带 owner 校验的 share。 */
export function findOwnedShareBySlug(userId: string, slug: string): Found {
  return findOwned(userId, eq(shares.slug, slug));
}

export function listSharesFor(userId: string): Share[] {
  return getDb()
    .select()
    .from(shares)
    .where(eq(shares.ownerId, userId))
    .orderBy(desc(shares.createdAt))
    .all();
}

export async function setSharePasswordFor(
  userId: string,
  shareId: string,
  password: string,
): Promise<ShareMutation> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!password || password.length > 200) return { error: "密码不能为空" };

  const passwordHash = await hashPassword(password);
  getDb()
    .update(shares)
    .set({ passwordHash, passwordVersion: sql`${shares.passwordVersion} + 1` })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

export function removeSharePasswordFor(
  userId: string,
  shareId: string,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;

  getDb()
    .update(shares)
    .set({ passwordHash: null, passwordVersion: sql`${shares.passwordVersion} + 1` })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

/** expiresAt 为 unix 毫秒；null 表示清除过期时间 */
export function setShareExpiryFor(
  userId: string,
  shareId: string,
  expiresAt: number | null,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (expiresAt !== null) {
    if (!Number.isFinite(expiresAt)) return { error: "时间格式不正确" };
    if (expiresAt <= Date.now()) return { error: "过期时间必须晚于现在" };
  }

  getDb().update(shares).set({ expiresAt }).where(eq(shares.id, shareId)).run();
  return {};
}

export async function deleteShareFor(
  userId: string,
  shareId: string,
): Promise<ShareMutation> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;

  // 先删 DB 行（此后链接立即 404），文件删除失败只记日志
  getDb().delete(shares).where(eq(shares.id, shareId)).run();
  await deleteFile(shareId);
  return {};
}
