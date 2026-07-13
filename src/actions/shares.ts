"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  deleteShareFor,
  removeSharePasswordFor,
  setShareExpiryFor,
  setSharePasswordFor,
} from "@/lib/shares/manage";

export type ShareActionResult = { error?: string };

// 分享管理的浏览器入口：认证走 cookie session，业务逻辑复用 src/lib/shares/manage.ts，
// 变更成功后 revalidatePath 刷新 dashboard。MCP 工具复用同一份 manage.* 逻辑（认证走 Bearer）。

export async function setSharePassword(
  shareId: string,
  password: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = await setSharePasswordFor(user.id, shareId, password);
  if (!res.error) revalidatePath("/dashboard");
  return res;
}

export async function removeSharePassword(
  shareId: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = removeSharePasswordFor(user.id, shareId);
  if (!res.error) revalidatePath("/dashboard");
  return res;
}

/** expiresAt 为 unix 毫秒；null 表示清除过期时间 */
export async function setShareExpiry(
  shareId: string,
  expiresAt: number | null,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = setShareExpiryFor(user.id, shareId, expiresAt);
  if (!res.error) revalidatePath("/dashboard");
  return res;
}

export async function deleteShare(shareId: string): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = await deleteShareFor(user.id, shareId);
  if (!res.error) revalidatePath("/dashboard");
  return res;
}
