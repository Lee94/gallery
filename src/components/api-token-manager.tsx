"use client";

import { useActionState, useState } from "react";
import { createApiToken, revokeApiToken } from "@/actions/api-tokens";
import { formatDateTime } from "@/lib/format";
import { CopyButton } from "./copy-button";
import {
  formErrorClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./ui";

export type TokenRow = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
};

export function ApiTokenManager({
  tokens,
  mcpUrl,
}: {
  tokens: TokenRow[];
  mcpUrl: string;
}) {
  const [state, formAction, pending] = useActionState(createApiToken, {});
  // 明文令牌只在生成后短暂展示；用户「关闭」后即从 DOM 移除，避免因页面其它操作
  // 触发 revalidate 后仍滞留（useActionState 的 state 不会随父组件 revalidate 清空）
  const [dismissed, setDismissed] = useState<string | null>(null);
  const revealToken = state.token && state.token !== dismissed ? state.token : null;

  const configSnippet = `{
  "mcpServers": {
    "gallery": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer <你的令牌>" }
    }
  }
}`;

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">令牌名称（便于区分用途）</span>
          <input
            name="name"
            defaultValue={state.name}
            placeholder="如：我的 Agent"
            maxLength={100}
            className={inputClass}
          />
        </label>
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          生成令牌
        </button>
      </form>

      {state.error && <p className={formErrorClass}>{state.error}</p>}

      {revealToken && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
              令牌已生成，只显示这一次，请立即复制并妥善保存：
            </p>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => setDismissed(revealToken)}
            >
              关闭
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-sm dark:bg-zinc-900">
              {revealToken}
            </code>
            <CopyButton text={revealToken} label="复制令牌" />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">MCP 连接配置</span>
          <CopyButton text={configSnippet} label="复制配置" />
        </div>
        <p className="text-xs text-zinc-500">
          在支持远程 MCP 的客户端（Claude Code / Desktop 等）中加入以下配置，把
          <code className="mx-1 font-mono">&lt;你的令牌&gt;</code>换成上面生成的令牌：
        </p>
        <pre className="overflow-x-auto rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
          {configSnippet}
        </pre>
      </div>

      {tokens.length === 0 ? (
        <p className="text-sm text-zinc-500">还没有令牌</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
            >
              <span className="text-sm font-medium">{t.name}</span>
              <span className="text-xs text-zinc-500" suppressHydrationWarning>
                {formatDateTime(t.createdAt)} 创建 ·{" "}
                {t.lastUsedAt ? `最近使用 ${formatDateTime(t.lastUsedAt)}` : "从未使用"}
                {t.expiresAt ? ` · 过期于 ${formatDateTime(t.expiresAt)}` : ""}
              </span>
              <span className="flex-1" />
              <form
                action={revokeApiToken.bind(null, t.id)}
                onSubmit={(e) => {
                  if (!confirm(`删除令牌「${t.name}」？使用它的 agent 将立即失去访问。`)) {
                    e.preventDefault();
                  }
                }}
              >
                <button type="submit" className={secondaryButtonClass}>
                  删除
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
