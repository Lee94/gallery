"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiTokens } from "@/db/schema";
import { generateApiToken } from "@/lib/auth/api-token";
import { getCurrentUser } from "@/lib/auth/current-user";

const MAX_TOKENS_PER_USER = 20;

// 创建后一次性回传明文 token 供展示（DB 只存 SHA-256，之后无法再取回）
export type CreateTokenState = { token?: string; name?: string; error?: string };

export async function createApiToken(
  _prev: CreateTokenState,
  formData: FormData,
): Promise<CreateTokenState> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };

  const name = String(formData.get("name") ?? "").trim().slice(0, 100) || "未命名令牌";

  const db = getDb();
  const existing = db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id))
    .all();
  if (existing.length >= MAX_TOKENS_PER_USER) {
    return { error: `令牌数量已达上限（${MAX_TOKENS_PER_USER}），请先删除不用的令牌`, name };
  }

  const { token, id } = generateApiToken();
  db.insert(apiTokens)
    .values({ id, userId: user.id, name, createdAt: Date.now() })
    .run();

  revalidatePath("/settings/tokens");
  return { token };
}

export async function revokeApiToken(tokenId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("请先登录");
  getDb()
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, user.id)))
    .run();
  revalidatePath("/settings/tokens");
}
