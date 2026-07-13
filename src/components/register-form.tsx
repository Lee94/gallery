"use client";

import Link from "next/link";
import { useActionState } from "react";
import { register, type AuthFormState } from "@/actions/auth";
import { formErrorClass, inputClass, primaryButtonClass } from "./ui";

export function RegisterForm({
  needsInvite,
  defaultInviteCode,
}: {
  needsInvite: boolean;
  defaultInviteCode?: string;
}) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    register,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm text-zinc-600 dark:text-zinc-400">邮箱</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.email}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          密码（至少 8 位）
        </span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
      </label>
      {needsInvite ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            邀请码
          </span>
          <input
            name="inviteCode"
            type="text"
            required
            defaultValue={state.inviteCode ?? defaultInviteCode}
            className={inputClass}
          />
        </label>
      ) : (
        <p className="rounded-md bg-indigo-50 px-3 py-2 text-sm text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
          你是第一位用户，将自动成为管理员
        </p>
      )}
      {state.error && <p className={formErrorClass}>{state.error}</p>}
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "注册中…" : "注册"}
      </button>
      <p className="text-center text-sm text-zinc-500">
        已有账号？{" "}
        <Link href="/login" className="text-indigo-600 hover:underline dark:text-indigo-400">
          登录
        </Link>
      </p>
    </form>
  );
}
