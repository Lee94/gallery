"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteShare,
  removeSharePassword,
  setShareExpiry,
  setSharePassword,
  type ShareActionResult,
} from "@/actions/shares";
import { CopyButton } from "./copy-button";
import {
  dangerButtonClass,
  inputClass,
  secondaryButtonClass,
} from "./ui";

export type ShareRow = {
  id: string;
  slug: string;
  originalName: string;
  size: number;
  kind: string;
  hasPassword: boolean;
  expiresAt: number | null;
  expired: boolean; // 服务端按请求时刻计算（render 内不允许调 Date.now）
  createdAt: number;
};

const KIND_LABELS: Record<string, string> = {
  html: "HTML",
  pdf: "PDF",
  image: "图片",
  markdown: "MD",
  text: "文本",
  other: "文件",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 转成 datetime-local 需要的 "YYYY-MM-DDTHH:mm"（本地时区） */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ShareItem({ share }: { share: ShareRow }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState(
    share.expiresAt ? toLocalInputValue(share.expiresAt) : "",
  );
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<ShareActionResult>) => {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (res.error) {
        setError(res.error);
      } else {
        setPassword("");
        router.refresh();
      }
    });
  };

  return (
    <li className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="w-12 shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-center text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {KIND_LABELS[share.kind] ?? share.kind}
        </span>
        <div className="min-w-0 flex-1">
          <a
            href={`/s/${share.slug}`}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-sm font-medium hover:text-indigo-600 dark:hover:text-indigo-400"
            title={share.originalName}
          >
            {share.originalName}
          </a>
          <p className="mt-0.5 text-xs text-zinc-500" suppressHydrationWarning>
            {formatSize(share.size)} · {formatDate(share.createdAt)}
            {share.hasPassword && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                🔒 有密码
              </span>
            )}
            {share.expiresAt && (
              <span className={`ml-2 ${share.expired ? "text-red-500" : ""}`}>
                {share.expired ? "已过期" : "过期于"} {formatDate(share.expiresAt)}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CopyButton path={`/s/${share.slug}`} />
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setExpanded((v) => !v)}
          >
            管理 {expanded ? "▴" : "▾"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-4 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">
                访问密码{share.hasPassword ? "（已设置，输入新密码可修改）" : ""}
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={share.hasPassword ? "新密码" : "设置密码"}
                autoComplete="new-password"
                className={inputClass}
              />
            </label>
            <button
              type="button"
              disabled={pending || !password}
              className={secondaryButtonClass + " disabled:opacity-50"}
              onClick={() => run(() => setSharePassword(share.id, password))}
            >
              {share.hasPassword ? "修改密码" : "设置密码"}
            </button>
            {share.hasPassword && (
              <button
                type="button"
                disabled={pending}
                className={secondaryButtonClass + " disabled:opacity-50"}
                onClick={() => run(() => removeSharePassword(share.id))}
              >
                移除密码
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">过期时间</span>
              <input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className={inputClass}
              />
            </label>
            <button
              type="button"
              disabled={pending || !expiry}
              className={secondaryButtonClass + " disabled:opacity-50"}
              onClick={() =>
                run(() =>
                  setShareExpiry(share.id, new Date(expiry).getTime()),
                )
              }
            >
              设置过期
            </button>
            {share.expiresAt && (
              <button
                type="button"
                disabled={pending}
                className={secondaryButtonClass + " disabled:opacity-50"}
                onClick={() => {
                  setExpiry("");
                  run(() => setShareExpiry(share.id, null));
                }}
              >
                永不过期
              </button>
            )}
          </div>

          <div className="flex items-center justify-between">
            <button
              type="button"
              disabled={pending}
              className={dangerButtonClass + " disabled:opacity-50"}
              onClick={() => {
                if (confirm(`确定删除「${share.originalName}」？链接将立即失效。`)) {
                  run(() => deleteShare(share.id));
                }
              }}
            >
              删除文件
            </button>
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function ShareList({ shares }: { shares: ShareRow[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {shares.map((share) => (
        <ShareItem key={share.id} share={share} />
      ))}
    </ul>
  );
}
