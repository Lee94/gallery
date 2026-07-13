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

/**
 * 复制按钮。
 * - 传 `path`：点击时拼上 window.location.origin 复制完整链接（避免 SSR 期访问 window）。
 * - 传 `text`：复制原始文本（如 API 令牌）。
 */
export function CopyButton({
  path,
  text,
  label = "复制链接",
}: {
  path?: string;
  text?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={secondaryButtonClass}
      onClick={async () => {
        await copyText(text ?? `${window.location.origin}${path ?? ""}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "已复制" : label}
    </button>
  );
}
