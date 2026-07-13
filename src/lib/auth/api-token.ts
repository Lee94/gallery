import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiTokens, users, type User } from "@/db/schema";

// MCP / 程序化访问的 Bearer 令牌。与 session.ts 同构：cookie/DB 里都不存明文，
// 只存 SHA-256(token)。前缀便于人眼识别与密钥扫描工具告警。
const TOKEN_PREFIX = "glry_";

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 生成一枚新令牌：明文 token 只在此刻返回一次，DB 存 id = SHA-256(token)。 */
export function generateApiToken(): { token: string; id: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, id: hashApiToken(token) };
}

/**
 * 校验 `Authorization: Bearer <token>` 头并返回令牌所属用户。
 * 无头 / 格式错 / 查无 / 已过期 一律返回 null（调用方据此回 401）。
 * better-sqlite3 是同步驱动，这里保持同步（不像 validateSession 需要 await cookies()）。
 */
export function validateApiToken(authHeader: string | null): User | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;

  const id = hashApiToken(match[1]!.trim());
  const db = getDb();
  const row = db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(eq(apiTokens.id, id))
    .get();
  if (!row) return null;

  const now = Date.now();
  if (row.token.expiresAt !== null && row.token.expiresAt <= now) return null;

  // 记录最近使用时间（尽力而为，失败不影响鉴权）
  db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, id)).run();
  return row.user;
}
