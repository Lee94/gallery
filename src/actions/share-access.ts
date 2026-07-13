"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { shares } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { createAccessCookie } from "@/lib/share-access";

export type GateFormState = { error?: string };

/** 访客提交分享密码：验证通过后签发 1 小时 HMAC 访问 cookie */
export async function unlockShare(
  _prev: GateFormState,
  formData: FormData,
): Promise<GateFormState> {
  const slug = String(formData.get("slug") ?? "");
  const password = String(formData.get("password") ?? "");

  const ip = await getClientIp();
  if (!rateLimit(`share-pass:${ip}:${slug}`, 10, 15 * 60 * 1000)) {
    return { error: "尝试过于频繁，请 15 分钟后再试" };
  }

  const share = getDb().select().from(shares).where(eq(shares.slug, slug)).get();
  if (!share || (share.expiresAt !== null && share.expiresAt <= Date.now())) {
    return { error: "分享不存在或已过期" };
  }
  if (share.passwordHash) {
    if (!password || !(await verifyPassword(share.passwordHash, password))) {
      return { error: "密码错误" };
    }
    const cookie = createAccessCookie(share);
    const store = await cookies();
    store.set(cookie.name, cookie.value, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: cookie.maxAge,
    });
  }
  redirect(`/s/${slug}`);
}
