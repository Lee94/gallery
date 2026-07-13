"use client";

import { useActionState } from "react";
import { unlockShare, type GateFormState } from "@/actions/share-access";
import { formErrorClass, inputClass, primaryButtonClass } from "./ui";

export function PasswordGateForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<GateFormState, FormData>(
    unlockShare,
    {},
  );

  return (
    <form action={action} className="flex w-full max-w-xs flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />
      <div className="text-center">
        <p className="text-lg font-medium">此分享受密码保护</p>
        <p className="mt-1 text-sm text-zinc-500">请输入访问密码</p>
      </div>
      <input
        name="password"
        type="password"
        required
        autoFocus
        autoComplete="off"
        placeholder="访问密码"
        className={inputClass}
      />
      {state.error && <p className={formErrorClass}>{state.error}</p>}
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "验证中…" : "查看"}
      </button>
    </form>
  );
}
