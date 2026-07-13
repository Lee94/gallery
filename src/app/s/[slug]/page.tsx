import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Share } from "@/db/schema";
import { resolveShareAccess } from "@/lib/share-access";
import { readFileText } from "@/lib/storage";
import { MarkdownViewer } from "@/components/markdown-viewer";
import { PasswordGateForm } from "@/components/password-gate-form";

const MARKDOWN_INLINE_LIMIT = 2 * 1024 * 1024; // 超过则降级为下载
const TEXT_INLINE_LIMIT = 1 * 1024 * 1024;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const access = await resolveShareAccess(slug);
  // 未解锁时不在 <title> 里泄露文件名
  if (access.status !== "ok") return { title: "分享" };
  return { title: access.share.originalName };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function DownloadCard({ share, rawUrl }: { share: Share; rawUrl: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border border-zinc-200 p-8 text-center dark:border-zinc-800">
        <p className="w-full truncate font-medium" title={share.originalName}>
          {share.originalName}
        </p>
        <p className="text-sm text-zinc-500">
          {formatSize(share.size)} · {share.mimeType}
        </p>
        <a
          href={`${rawUrl}?download=1`}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          下载文件
        </a>
      </div>
    </div>
  );
}

async function Viewer({ share, rawUrl }: { share: Share; rawUrl: string }) {
  switch (share.kind) {
    case "html":
      return (
        <iframe
          src={rawUrl}
          // 无 allow-same-origin：脚本运行在 opaque origin，与 raw 端点的 CSP sandbox 双保险
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
          className="w-full flex-1 border-0 bg-white"
          title={share.originalName}
        />
      );
    case "pdf":
      return (
        <iframe
          src={rawUrl}
          className="w-full flex-1 border-0"
          title={share.originalName}
        />
      );
    case "image":
      return (
        <div className="flex flex-1 items-center justify-center overflow-auto bg-zinc-100 p-6 dark:bg-zinc-900">
          {/* 用户上传的任意图片，无法用 next/image 优化管线 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={rawUrl}
            alt={share.originalName}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case "markdown": {
      if (share.size > MARKDOWN_INLINE_LIMIT) {
        return <DownloadCard share={share} rawUrl={rawUrl} />;
      }
      const content = await readFileText(share.id);
      return (
        <div className="flex-1 overflow-auto">
          <MarkdownViewer content={content} />
        </div>
      );
    }
    case "text": {
      if (share.size > TEXT_INLINE_LIMIT) {
        return <DownloadCard share={share} rawUrl={rawUrl} />;
      }
      const content = await readFileText(share.id);
      return (
        <pre className="flex-1 overflow-auto whitespace-pre-wrap px-6 py-8 font-mono text-sm">
          {content}
        </pre>
      );
    }
    default:
      return <DownloadCard share={share} rawUrl={rawUrl} />;
  }
}

export default async function SharePage({ params }: Props) {
  const { slug } = await params;
  const access = await resolveShareAccess(slug);

  if (access.status === "not_found") notFound();

  if (access.status === "locked") {
    return (
      <main className="flex h-dvh items-center justify-center p-6">
        <PasswordGateForm slug={slug} />
      </main>
    );
  }

  const { share } = access;
  const rawUrl = `/api/raw/${slug}`;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <span
          className="min-w-0 truncate text-sm font-medium"
          title={share.originalName}
        >
          {share.originalName}
        </span>
        <span className="flex shrink-0 items-center gap-4 text-sm text-zinc-500">
          <span>{formatSize(share.size)}</span>
          <a
            href={`${rawUrl}?download=1`}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            下载
          </a>
        </span>
      </header>
      <Viewer share={share} rawUrl={rawUrl} />
    </div>
  );
}
