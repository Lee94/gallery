import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Share } from "@/db/schema";
import { resolveShareAccess } from "@/lib/share-access";
import { readFileText } from "@/lib/storage";
import { MarkdownViewer } from "@/components/markdown-viewer";
import { CommentsPanel } from "@/components/comments-panel";
import { PageStateHtmlViewer } from "@/components/page-state-html-viewer";
import { PasswordGateForm } from "@/components/password-gate-form";
import { ForkButton, FullscreenButton } from "@/components/share-actions";
import { SourceBrowser } from "@/components/source-browser";
import { getEnv } from "@/lib/env";

const MARKDOWN_INLINE_LIMIT = 2 * 1024 * 1024; // 超过则降级为下载
const TEXT_INLINE_LIMIT = 1 * 1024 * 1024;

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ v?: string; embed?: string; source?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const access = await resolveShareAccess(slug);
  // 未解锁时不在 <title> 里泄露文件名
  if (access.status !== "ok") return { title: "分享" };
  const { share } = access;
  const title = share.title ?? share.originalName;
  const coverUrl = share.coverPath
    ? `${getEnv().appUrl}/api/raw/${share.slug}/${share.coverPath.split("/").map(encodeURIComponent).join("/")}`
    : undefined;
  return {
    metadataBase: new URL(getEnv().appUrl),
    title,
    description: share.description || undefined,
    openGraph: {
      title,
      description: share.description || undefined,
      type: "website",
      url: `/s/${share.slug}`,
      images: coverUrl ? [{ url: coverUrl, alt: title }] : undefined,
    },
  };
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

async function Viewer({
  share,
  rawUrl,
  isVersionPreview,
}: {
  share: Share;
  rawUrl: string;
  isVersionPreview: boolean;
}) {
  switch (share.kind) {
    case "html":
      // 历史版本预览：不挂数据桥（旧版不该写现在的数据），用普通 iframe
      if (isVersionPreview) {
        return (
          <iframe
            src={rawUrl}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            allowFullScreen
            className="w-full flex-1 border-0 bg-white"
            title={share.originalName}
          />
        );
      }
      return (
        <PageStateHtmlViewer
          rawUrl={rawUrl}
          slug={share.slug}
          title={share.originalName}
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
      const content = await readFileText(share.id, share.entryPath);
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
      const content = await readFileText(share.id, share.entryPath);
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

export default async function SharePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { v, embed, source } = await searchParams;
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
  // iframe src 指向 /api/raw/<slug>/<path>：子页面里 href="app.js" 会被浏览器解析成
  // /api/raw/<slug>/app.js 并命中 raw 子路径路由，多文件 artifact 的相对路径因此可用。
  // ?v=n 时 iframe 指 /api/raw/<slug>/v/<n>/<entryPath>，历史版本不挂数据桥。
  const versionNo = v ? Number(v) : null;
  const isVersionPreview =
    versionNo !== null && Number.isSafeInteger(versionNo) && versionNo >= 1;
  const rawUrl = share.runtime === "react"
    ? `/api/runtime/${slug}${isVersionPreview ? `?v=${versionNo}` : ""}`
    : isVersionPreview
    ? `/api/raw/${slug}/v/${versionNo}/${share.entryPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`
    : `/api/raw/${slug}/${share.entryPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
  const isEmbed = embed === "1";
  const showSource = source === "1";
  if (showSource && !share.sourceEnabled) notFound();
  const displayTitle = share.title ?? share.originalName;

  return (
    <div className="flex h-dvh flex-col">
      {!isEmbed && (
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <span
          className="min-w-0 truncate text-sm font-medium"
          title={displayTitle}
        >
          {share.icon && <span className="mr-1">{share.icon}</span>}{displayTitle}
        </span>
        <span className="flex shrink-0 items-center gap-4 text-sm text-zinc-500">
          {isVersionPreview && (
            <span className="text-amber-600 dark:text-amber-400">
              历史版本 v{versionNo}
            </span>
          )}
          {share.pageStateEnabled && (
            <span
              className="text-indigo-600 dark:text-indigo-400"
              title="所有能访问此分享的人共用并可修改页面数据；刷新后看到他人的修改"
            >
              共享数据
            </span>
          )}
          {share.visitorStateEnabled && (
            <span
              className="text-emerald-600 dark:text-emerald-400"
              title="每个访客有独立数据，互不可见"
            >
              访客数据
            </span>
          )}
          {share.kvEnabled && (
            <span
              className="text-violet-600 dark:text-violet-400"
              title="行级共享数据，访客都可读写"
            >
              行集
            </span>
          )}
          {share.llmEnabled && (
            <span
              className="text-rose-600 dark:text-rose-400"
              title="页面内可调用 LLM"
            >
              LLM
            </span>
          )}
          {share.commentsEnabled && (
            <CommentsPanel
              slug={share.slug}
              isOwner={access.isOwner}
              visitorWrite={share.commentsVisitorWrite}
            />
          )}
          {share.sourceEnabled && (
            <a href={`/s/${share.slug}?source=1`} className="text-indigo-600 hover:underline dark:text-indigo-400">源码</a>
          )}
          <a href={`/api/export/${share.slug}`} className="text-indigo-600 hover:underline dark:text-indigo-400">ZIP</a>
          <ForkButton slug={share.slug} />
          <FullscreenButton />
          <span>{formatSize(share.size)}</span>
          <a
            href={`${rawUrl}?download=1`}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            下载
          </a>
        </span>
      </header>
      )}
      {showSource ? (
        <SourceBrowser share={share} />
      ) : (
        <Viewer share={share} rawUrl={rawUrl} isVersionPreview={isVersionPreview} />
      )}
    </div>
  );
}
