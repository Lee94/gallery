"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { forkShare } from "@/actions/shares";

export function ForkButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        title="复制当前文件到自己的 Gallery；不会复制私有数据、附件或评论"
        onClick={() => startTransition(async () => {
          setError(null);
          const result = await forkShare(slug);
          if (result.error) setError(result.error);
          else if (result.slug) router.push(`/dashboard/${result.slug}`);
        })}
        className="text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
      >
        {pending ? "Fork 中…" : "Fork"}
      </button>
      {error && <span className="max-w-48 truncate text-xs text-red-600" title={error}>{error}</span>}
    </span>
  );
}

export function FullscreenButton() {
  return (
    <button
      type="button"
      className="text-indigo-600 hover:underline dark:text-indigo-400"
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }}
    >
      全屏
    </button>
  );
}
