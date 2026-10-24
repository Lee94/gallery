import { listShareFiles } from "@/lib/shares/manage";
import { readFileText } from "@/lib/storage";
import type { Share } from "@/db/schema";

const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 2 * 1024 * 1024;

export async function SourceBrowser({ share }: { share: Share }) {
  const files = listShareFiles(share.id);
  let remaining = MAX_SOURCE_TOTAL_BYTES;
  const sources: Array<(typeof files)[number] & { content: string | null }> = [];
  for (const file of files) {
    if (!file.mimeType.startsWith("text/") || file.sizeBytes > MAX_SOURCE_FILE_BYTES || file.sizeBytes > remaining) {
      sources.push({ ...file, content: null });
      continue;
    }
    remaining -= file.sizeBytes;
    try {
      sources.push({ ...file, content: await readFileText(share.id, file.path) });
    } catch {
      sources.push({ ...file, content: null });
    }
  }
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 overflow-auto p-4 sm:p-6">
      <p className="text-sm text-zinc-500">共 {files.length} 个文件；大文件和二进制文件请下载后查看。</p>
      {sources.map((file) => (
        <section key={file.path} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="min-w-0 break-all font-mono text-xs">{file.path}{file.path === share.entryPath ? " · 入口" : ""}</span>
            <a className="shrink-0 text-xs text-indigo-600 hover:underline" href={`/api/raw/${share.slug}/${file.path.split("/").map(encodeURIComponent).join("/")}?download=1`}>下载</a>
          </header>
          {file.content === null ? (
            <p className="p-3 text-xs text-zinc-500">此文件不支持在线源码预览。</p>
          ) : (
            <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">{file.content}</pre>
          )}
        </section>
      ))}
    </main>
  );
}
