import type { ShareKind } from "@/db/schema";

export interface FileTypeInfo {
  kind: ShareKind;
  mimeType: string;
}

// 扩展名白名单：不在表内的一律按 other（application/octet-stream，强制下载）处理。
// 不信任客户端提供的 MIME type。
const EXT_MAP: Record<string, FileTypeInfo> = {
  html: { kind: "html", mimeType: "text/html" },
  htm: { kind: "html", mimeType: "text/html" },
  pdf: { kind: "pdf", mimeType: "application/pdf" },
  png: { kind: "image", mimeType: "image/png" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  gif: { kind: "image", mimeType: "image/gif" },
  webp: { kind: "image", mimeType: "image/webp" },
  avif: { kind: "image", mimeType: "image/avif" },
  ico: { kind: "image", mimeType: "image/x-icon" },
  // SVG 可以内嵌脚本，raw 端点会对它下发禁脚本的 CSP
  svg: { kind: "image", mimeType: "image/svg+xml" },
  md: { kind: "markdown", mimeType: "text/markdown" },
  markdown: { kind: "markdown", mimeType: "text/markdown" },
  txt: { kind: "text", mimeType: "text/plain" },
  log: { kind: "text", mimeType: "text/plain" },
  json: { kind: "text", mimeType: "text/plain" },
  csv: { kind: "text", mimeType: "text/plain" },
  js: { kind: "text", mimeType: "text/plain" },
  ts: { kind: "text", mimeType: "text/plain" },
  css: { kind: "text", mimeType: "text/plain" },
  xml: { kind: "text", mimeType: "text/plain" },
  yaml: { kind: "text", mimeType: "text/plain" },
  yml: { kind: "text", mimeType: "text/plain" },
  toml: { kind: "text", mimeType: "text/plain" },
};

export function classifyFile(filename: string): FileTypeInfo {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return EXT_MAP[ext] ?? { kind: "other", mimeType: "application/octet-stream" };
}

/**
 * raw 端点的响应头策略（集中定义，防止各处不一致）：
 * - html：CSP sandbox（无 allow-same-origin）→ 即使直接打开 raw URL，文档也运行在
 *   opaque origin，读不到主站 cookie/localStorage
 * - svg：CSP sandbox 且不允许脚本
 * - other：强制按附件下载
 */
export function rawContentHeaders(info: {
  kind: ShareKind;
  mimeType: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
  };
  if (info.kind === "html") {
    headers["Content-Type"] = `${info.mimeType}; charset=utf-8`;
    headers["Content-Security-Policy"] =
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";
  } else if (info.mimeType === "image/svg+xml") {
    headers["Content-Type"] = info.mimeType;
    headers["Content-Security-Policy"] = "sandbox";
  } else if (info.kind === "markdown" || info.kind === "text") {
    headers["Content-Type"] = `${info.mimeType}; charset=utf-8`;
  } else {
    headers["Content-Type"] = info.mimeType;
  }
  return headers;
}
