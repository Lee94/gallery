"use client";

import Link from "next/link";
import { useActionState } from "react";
import { login, type AuthFormState } from "@/actions/auth";
import { formErrorClass, inputClass, primaryButtonClass } from "./ui";

export function LoginForm() {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    login,
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
        <span className="text-sm text-zinc-600 dark:text-zinc-400">密码</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </label>
      {state.error && <p className={formErrorClass}>{state.error}</p>}
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "登录中…" : "登录"}
      </button>
      <p className="text-center text-sm text-zinc-500">
        还没有账号？{" "}
        <Link href="/register" className="text-indigo-600 hover:underline dark:text-indigo-400">
          注册
        </Link>
      </p>
    </form>
  );
}
