import { createHmac, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { shares, type Share } from "@/db/schema";
import { validateSession } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";

// 密码分享的访问令牌：无服务端状态的 HMAC 签名 cookie。
// payload 里带 passwordVersion，改/删/重设密码只需 version++ 即可让所有已发令牌失效。

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 小时

function sign(payload: string): string {
  return createHmac("sha256", getEnv().sessionSecret)
    .update(payload)
    .digest("base64url");
}

export function accessCookieName(shareId: string): string {
  return `sa_${shareId}`;
}

export function createAccessCookie(share: Share): {
  name: string;
  value: string;
  maxAge: number;
} {
  const exp = Date.now() + ACCESS_TTL_MS;
  const payload = Buffer.from(
    `${share.id}.${share.passwordVersion}.${exp}`,
  ).toString("base64url");
  return {
    name: accessCookieName(share.id),
    value: `${payload}.${sign(payload)}`,
    maxAge: ACCESS_TTL_MS / 1000,
  };
}

export function verifyAccessToken(
  share: Share,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }
  const [id, version, exp] = Buffer.from(payload, "base64url")
    .toString()
    .split(".");
  return (
    id === share.id &&
    Number(version) === share.passwordVersion &&
    Number(exp) > Date.now()
  );
}

export type ShareAccess =
  | { status: "not_found" }
  // 有密码且未解锁：share 只用于渲染密码门，页面不得外泄文件名等元数据
  | { status: "locked"; share: Share }
  | { status: "ok"; share: Share; isOwner: boolean };

/**
 * 预览页与 raw 端点共用的访问判定（React cache：同一请求内 generateMetadata/page 只查一次）。
 * 不存在与已过期统一返回 not_found，防枚举。
 */
export const resolveShareAccess = cache(
  async (slug: string): Promise<ShareAccess> => {
    const share = getDb().select().from(shares).where(eq(shares.slug, slug)).get();
    if (!share) return { status: "not_found" };
    if (share.expiresAt !== null && share.expiresAt <= Date.now()) {
      return { status: "not_found" };
    }
    if (!share.passwordHash) return { status: "ok", share, isOwner: false };

    const session = await validateSession();
    if (session && session.user.id === share.ownerId) {
      return { status: "ok", share, isOwner: true };
    }

    const store = await cookies();
    const token = store.get(accessCookieName(share.id))?.value;
    if (verifyAccessToken(share, token)) {
      return { status: "ok", share, isOwner: false };
    }
    return { status: "locked", share };
  },
);
