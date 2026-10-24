import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import posix from "node:path/posix";
import { build, type Loader, type Plugin } from "esbuild";
import { getEnv } from "@/lib/env";
import {
  REACT_RUNTIME_BUILD_VERSION,
  REACT_RUNTIME_DEPENDENCIES,
  REACT_RUNTIME_VERSION,
} from "@/lib/runtime-config";

export interface ReactSourceFile {
  path: string;
  content: Uint8Array;
}

const LOADERS: Record<string, Loader> = {
  ".js": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
  ".json": "json",
  ".css": "css",
  ".txt": "text",
  ".svg": "dataurl",
  ".png": "dataurl",
  ".jpg": "dataurl",
  ".jpeg": "dataurl",
  ".gif": "dataurl",
  ".webp": "dataurl",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function documentHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>React Artifact</title></head><body>${body}</body></html>`;
}

export function reactBuildErrorHtml(message: string): string {
  return documentHtml(`<main style="font:14px/1.6 system-ui;max-width:960px;margin:40px auto;padding:0 20px"><h1 style="font-size:20px">Artifact 构建失败</h1><pre style="white-space:pre-wrap;background:#18181b;color:#fca5a5;padding:16px;border-radius:8px">${escapeHtml(message)}</pre><p>仅支持相对导入和固定版本的 React 依赖，不允许安装其他包。</p></main>`);
}

function entryProgram(entryPath: string): string {
  const importPath = `./${entryPath}`;
  return `
import React from "react";
import { createRoot } from "react-dom/client";
import App from ${JSON.stringify(importPath)};
class GalleryErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return React.createElement("pre", { style: { whiteSpace: "pre-wrap", color: "#b91c1c", padding: 20 } }, String(this.state.error));
    return this.props.children;
  }
}
const showRuntimeError = (error) => {
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;color:#b91c1c;padding:20px";
  pre.textContent = String(error && (error.stack || error.message) || error);
  document.getElementById("root").replaceChildren(pre);
};
window.addEventListener("error", (event) => showRuntimeError(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => showRuntimeError(event.reason));
createRoot(document.getElementById("root")).render(React.createElement(GalleryErrorBoundary, null, React.createElement(App)));
`;
}

function cacheKey(files: ReactSourceFile[], entryPath: string, runtimeVersion: string): string {
  const hash = createHash("sha256");
  hash.update(`react-builder:${REACT_RUNTIME_BUILD_VERSION}:${runtimeVersion}:${entryPath}\0`);
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function cachePath(key: string): string {
  return path.join(getEnv().dataDir, "cache", "react", `${key}.html`);
}

function sourcePlugin(files: ReactSourceFile[]): Plugin {
  const sources = new Map(files.map((file) => [file.path, file.content]));
  const resolveSource = (specifier: string, importer: string) => {
    if (specifier.startsWith("/") || specifier.includes("\\")) return null;
    const base = importer ? posix.dirname(importer) : "";
    const resolved = posix.normalize(posix.join(base, specifier));
    if (resolved.startsWith("../") || resolved === "..") return null;
    const extension = posix.extname(resolved);
    const candidates = extension
      ? [resolved]
      : [resolved, ...Object.keys(LOADERS).map((ext) => `${resolved}${ext}`), ...Object.keys(LOADERS).map((ext) => `${resolved}/index${ext}`)];
    return candidates.find((candidate) => sources.has(candidate)) ?? null;
  };
  return {
    name: "gallery-react-sources",
    setup(build) {
      build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        if (args.namespace !== "artifact" && posix.basename(args.importer) !== "__gallery_entry.jsx") return undefined;
        const resolved = resolveSource(args.path, posix.basename(args.importer) === "__gallery_entry.jsx" ? "" : args.importer);
        if (!resolved) return { errors: [{ text: `无法解析相对导入 ${args.path}；文件必须包含在 Artifact 中且不能越出根目录` }] };
        return { path: resolved, namespace: "artifact" };
      });
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.namespace !== "artifact" && posix.basename(args.importer) !== "__gallery_entry.jsx") return undefined;
        if ((REACT_RUNTIME_DEPENDENCIES as readonly string[]).includes(args.path)) return undefined;
        return { errors: [{ text: `依赖 ${args.path} 不在白名单；仅支持 ${REACT_RUNTIME_DEPENDENCIES.join(", ")}` }] };
      });
      build.onLoad({ filter: /.*/, namespace: "artifact" }, (args) => ({
        contents: sources.get(args.path),
        loader: LOADERS[posix.extname(args.path)] ?? "text",
        resolveDir: process.cwd(),
      }));
    },
  };
}

const pending = new Map<string, Promise<string>>();

async function compile(files: ReactSourceFile[], entryPath: string, key: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: entryProgram(entryPath),
      loader: "jsx",
      sourcefile: "__gallery_entry.jsx",
      resolveDir: process.cwd(),
    },
    outfile: "artifact.js",
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [sourcePlugin(files)],
  });
  const js = result.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!js) throw new Error("编译器没有生成 JS 输出");
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
  // 避免用户源字符串中的 </script> 提前结束宿主 script 标签。
  const script = js.text.replace(/<\/script/gi, "<\\/script");
  const html = documentHtml(`<div id="root"></div>${css ? `<style>${css.text.replace(/<\/style/gi, "<\\/style")}</style>` : ""}<script src="/sdk/page-state-v1.js"></script><script>${script}</script>`);
  const target = cachePath(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, html);
  await fsp.rename(tmp, target);
  return html;
}

export async function buildReactArtifact(input: {
  files: ReactSourceFile[];
  entryPath: string;
  runtimeVersion: string;
}): Promise<string> {
  if (input.runtimeVersion !== REACT_RUNTIME_VERSION) {
    return reactBuildErrorHtml(`此 Artifact 锁定 React ${input.runtimeVersion}，服务器仅提供 ${REACT_RUNTIME_VERSION}。`);
  }
  if (!input.files.some((file) => file.path === input.entryPath)) {
    return reactBuildErrorHtml(`入口 ${input.entryPath} 不存在。`);
  }
  const key = cacheKey(input.files, input.entryPath, input.runtimeVersion);
  try {
    return await fsp.readFile(cachePath(key), "utf8");
  } catch {}
  const existing = pending.get(key);
  if (existing) return existing;
  const task = (async () => {
    try {
      return await compile(input.files, input.entryPath, key);
    } catch (error) {
      const messages = typeof error === "object" && error !== null && "errors" in error
        ? (error as { errors: Array<{ text: string; location?: { file: string; line: number } | null }> }).errors
        : null;
      const detail = messages?.length
        ? messages.map((item) => `${item.location ? `${item.location.file}:${item.location.line}: ` : ""}${item.text}`).join("\n")
        : error instanceof Error ? error.message : String(error);
      return reactBuildErrorHtml(detail);
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, task);
  return task;
}
