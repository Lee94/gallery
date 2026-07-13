"use server";

import { redirect } from "next/navigation";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDb } from "@/db";
import { inviteCodes, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, invalidateSession } from "@/lib/auth/session";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

// error 之外回传用户已填的字段：React 19 在 action 完成后会重置表单，用 defaultValue 回填
export type AuthFormState = { error?: string; email?: string; inviteCode?: string };

// 事务内业务失败（邀请码无效等）用异常携带用户可见信息，与意外错误区分
class RegisterError extends Error {}

const registerSchema = z.object({
  email: z.email("邮箱格式不正确"),
  password: z.string().min(8, "密码至少需要 8 位").max(200, "密码过长"),
  inviteCode: z.string().trim().optional(),
});

function isEmailTaken(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return `${e.message} ${cause}`.includes("UNIQUE constraint failed: users.email");
}

export async function register(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const ip = await getClientIp();
  const rawEmail = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const rawInvite = String(formData.get("inviteCode") ?? "").trim();
  const filled = { email: rawEmail, inviteCode: rawInvite };

  if (!rateLimit(`register:${ip}`, 5, 60 * 60 * 1000)) {
    return { error: "注册尝试过于频繁，请稍后再试", ...filled };
  }

  const parsed = registerSchema.safeParse({
    email: rawEmail,
    password: formData.get("password"),
    inviteCode: rawInvite || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message, ...filled };
  }
  const { email, password, inviteCode } = parsed.data;

  const passwordHash = await hashPassword(password);
  const db = getDb();
  const now = Date.now();
  const userId = nanoid(16);

  try {
    // better-sqlite3 为同步驱动，事务回调内全部同步执行；
    // 首用户判断放在事务内，避免并发注册出现两个 admin
    db.transaction((tx) => {
      const count = tx
        .select({ c: sql<number>`count(*)` })
        .from(users)
        .get()!.c;
      const isFirstUser = count === 0;

      let inviteId: string | undefined;
      if (!isFirstUser) {
        if (!inviteCode) throw new RegisterError("注册需要邀请码");
        const invite = tx
          .select()
          .from(inviteCodes)
          .where(
            and(eq(inviteCodes.code, inviteCode), isNull(inviteCodes.usedBy)),
          )
          .get();
        if (!invite) throw new RegisterError("邀请码无效或已被使用");
        inviteId = invite.id;
      }

      // 先插用户再核销邀请码：invite_codes.used_by 外键引用 users.id
      tx.insert(users)
        .values({
          id: userId,
          email,
          passwordHash,
          role: isFirstUser ? "admin" : "user",
          createdAt: now,
        })
        .run();

      if (inviteId) {
        tx.update(inviteCodes)
          .set({ usedBy: userId, usedAt: now })
          .where(eq(inviteCodes.id, inviteId))
          .run();
      }
    });
  } catch (e) {
    if (e instanceof RegisterError) return { error: e.message, ...filled };
    if (isEmailTaken(e)) return { error: "该邮箱已注册", ...filled };
    throw e;
  }

  await createSession(userId);
  redirect("/dashboard");
}

export async function login(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const ip = await getClientIp();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!rateLimit(`login:${ip}:${email}`, 10, 15 * 60 * 1000)) {
    return { error: "登录尝试过于频繁，请 15 分钟后再试", email };
  }
  if (!email || !password) return { error: "请输入邮箱和密码", email };

  const user = getDb().select().from(users).where(eq(users.email, email)).get();
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    return { error: "邮箱或密码错误", email };
  }

  await createSession(user.id);
  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  await invalidateSession();
  redirect("/login");
}
