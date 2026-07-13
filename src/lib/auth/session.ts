import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users, type Session, type User } from "@/db/schema";

export const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000; // 剩余不足 15 天时滑动续期

// cookie 里存原始 token，DB 只存 SHA-256(token)：DB 泄露不等于 session 泄露
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function setSessionCookie(token: string, expiresAt: number) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  getDb()
    .insert(sessions)
    .values({ id: hashToken(token), userId, expiresAt, createdAt: now })
    .run();
  await setSessionCookie(token, expiresAt);
}

export async function validateSession(): Promise<{
  user: User;
  session: Session;
} | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = getDb();
  const id = hashToken(token);
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;

  const now = Date.now();
  if (row.session.expiresAt <= now) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }

  if (row.session.expiresAt - now < RENEW_THRESHOLD_MS) {
    const expiresAt = now + SESSION_TTL_MS;
    db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run();
    row.session = { ...row.session, expiresAt };
    try {
      await setSessionCookie(token, expiresAt);
    } catch {
      // Server Component 渲染期间不允许写 cookie，DB 侧已续期，下次 action/route 里会补写
    }
  }

  return row;
}

export async function invalidateSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    getDb().delete(sessions).where(eq(sessions.id, hashToken(token))).run();
  }
  store.delete(SESSION_COOKIE);
}
