"use client";

import { useState } from "react";
import { secondaryButtonClass } from "./ui";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非安全上下文（如局域网 http）没有 clipboard API，退化为 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** path 会在点击时拼上 window.location.origin（避免 SSR 期访问 window） */
export function CopyButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={secondaryButtonClass}
      onClick={async () => {
        await copyText(`${window.location.origin}${path}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "已复制" : "复制链接"}
    </button>
  );
}
