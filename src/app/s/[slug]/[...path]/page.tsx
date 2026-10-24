import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { shareFiles } from "@/db/schema";
import { classifyFile } from "@/lib/file-kind";
import { resolveShareAccess } from "@/lib/share-access";
import { isValidSharePath, readFileText } from "@/lib/storage";
import { MarkdownViewer } from "@/components/markdown-viewer";
import { PageStateHtmlViewer } from "@/components/page-state-html-viewer";
import { PasswordGateForm } from "@/components/password-gate-form";
import { getEnv } from "@/lib/env";

const MARKDOWN_INLINE_LIMIT = 2 * 1024 * 1024;
const TEXT_INLINE_LIMIT = 1 * 1024 * 1024;

type Props = { params: Promise<{ slug: string; path: string[] }> };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function resolveFile(slug: string, segments: string[]) {
  const relPath = segments.map(decodeURIComponent).join("/");
  if (!isValidSharePath(relPath)) return null;
  const access = await resolveShareAccess(slug);
  if (access.status !== "ok") return { access, relPath, file: null };
  const file = getDb()
    .select()
    .from(shareFiles)
    .where(and(eq(shareFiles.shareId, access.share.id), eq(shareFiles.path, relPath)))
    .get();
  return { access, relPath, file: file ?? null };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, path } = await params;
  const resolved = await resolveFile(slug, path);
  if (!resolved || resolved.access.status !== "ok" || !resolved.file) {
    return { title: "分享" };
  }
  return { title: resolved.relPath.split("/").pop() ?? resolved.relPath };
}

export default async function ShareSubPage({ params }: Props) {
  const { slug, path } = await params;
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") notFound();
  if (access.status === "locked") {
    return (
      <main className="flex h-dvh items-center justify-center p-6">
        <PasswordGateForm slug={slug} />
      </main>
    );
  }

  const resolved = await resolveFile(slug, path);
  if (!resolved || !resolved.file) notFound();
  const { share } = access;
  const relPath = resolved.relPath;
  const fileInfo = classifyFile(relPath);
  const fileName = relPath.split("/").pop() ?? relPath;
  // iframe src 指向 /api/raw/...：子页面里 href="x.css" 会被浏览器基于 /api/raw/<slug>/
  // 解析成 /api/raw/<slug>/x.css，命中 raw 子路径路由，多文件相对路径可用。
  const rawUrl = `/api/raw/${slug}/${relPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  let viewer: React.ReactNode;
  switch (fileInfo.kind) {
    case "html":
      viewer = (
        <PageStateHtmlViewer
          rawUrl={rawUrl}
          slug={share.slug}
          title={fileName}
          maxStateBytes={getEnv().maxPageStateSizeBytes}
          pageStateEnabled={share.pageStateEnabled}
          visitorStateEnabled={share.visitorStateEnabled}
          kvEnabled={share.kvEnabled}
          attachmentsEnabled={share.attachmentsEnabled}
          maxAttachmentBytes={getEnv().attachmentLimits.fileBytes}
          llmEnabled={share.llmEnabled}
          dataGeneration={share.dataGeneration}
          dataSchemaVersion={share.dataSchemaVersion}
        />
      );
      break;
    case "pdf":
      viewer = (
        <iframe src={rawUrl} className="w-full flex-1 border-0" title={fileName} />
      );
      break;
    case "image":
      viewer = (
        <div className="flex flex-1 items-center justify-center overflow-auto bg-zinc-100 p-6 dark:bg-zinc-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={rawUrl}
            alt={fileName}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
      break;
    case "markdown": {
      if (resolved.file.sizeBytes > MARKDOWN_INLINE_LIMIT) {
        viewer = (
          <div className="flex flex-1 items-center justify-center p-6">
            <a href={`${rawUrl}?download=1`} className="text-indigo-600">
              下载 {fileName}
            </a>
          </div>
        );
      } else {
        const content = await readFileText(share.id, relPath);
        viewer = (
          <div className="flex-1 overflow-auto">
            <MarkdownViewer content={content} />
          </div>
        );
      }
      break;
    }
    case "text": {
      if (resolved.file.sizeBytes > TEXT_INLINE_LIMIT) {
        viewer = (
          <div className="flex flex-1 items-center justify-center p-6">
            <a href={`${rawUrl}?download=1`} className="text-indigo-600">
              下载 {fileName}
            </a>
          </div>
        );
      } else {
        const content = await readFileText(share.id, relPath);
        viewer = (
          <pre className="flex-1 overflow-auto whitespace-pre-wrap px-6 py-8 font-mono text-sm">
            {content}
          </pre>
        );
      }
      break;
    }
    default:
      viewer = (
        <div className="flex flex-1 items-center justify-center p-6">
          <a href={`${rawUrl}?download=1`} className="text-indigo-600">
            下载 {fileName}
          </a>
        </div>
      );
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <span className="min-w-0 truncate text-sm font-medium" title={relPath}>
          {fileName}
        </span>
        <span className="flex shrink-0 items-center gap-4 text-sm text-zinc-500">
          <span className="text-zinc-400">{relPath}</span>
          <span>{formatSize(resolved.file.sizeBytes)}</span>
          <a
            href={`${rawUrl}?download=1`}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            下载
          </a>
        </span>
      </header>
      {viewer}
    </div>
  );
}
