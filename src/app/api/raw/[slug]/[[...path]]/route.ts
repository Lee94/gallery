import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { shareFiles } from "@/db/schema";
import { classifyFile, rawContentHeaders } from "@/lib/file-kind";
import { resolveShareAccess } from "@/lib/share-access";
import {
  isValidSharePath,
  readFileStream,
  statFile,
} from "@/lib/storage";
import {
  blobPath,
  getVersionManifest,
} from "@/lib/shares/versions";
import fs from "node:fs";

function encodeRFC5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * /api/raw/<slug>/<path...>
 *  - path 省略时回落到 share.entryPath
 *  - path 必须在 share_files 清单里（不在即 404，防目录穿越到未发布文件）
 *  - path 段拼好后过 isValidSharePath 再查库（双保险）
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  const { slug, path: segments } = await ctx.params;
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (access.status === "locked") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { share } = access;

  // 历史版本：/api/raw/<slug>/v/<n>/<path> 直接按 manifest 读 blob
  if (segments?.[0] === "v" && segments.length >= 3) {
    const versionNo = Number(segments[1]);
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) {
      return new NextResponse("Not Found", { status: 404 });
    }
    const relPath = segments
      .slice(2)
      .map((s) => decodeURIComponent(s))
      .join("/");
    if (!isValidSharePath(relPath)) {
      return new NextResponse("Not Found", { status: 404 });
    }
    const manifest = getVersionManifest(share.id, versionNo);
    if (!manifest) return new NextResponse("Not Found", { status: 404 });
    const entry = manifest.find((m) => m.path === relPath);
    if (!entry) return new NextResponse("Not Found", { status: 404 });

    const fileInfo = classifyFile(relPath);
    const headers = rawContentHeaders({
      kind: fileInfo.kind,
      mimeType: entry.mimeType,
    });
    const stat = fs.statSync(blobPath(entry.sha256));
    headers["Content-Length"] = String(stat.size);
    headers["Cache-Control"] = "public, max-age=31536000, immutable"; // 版本内容不可变
    const download = request.nextUrl.searchParams.get("download") === "1";
    const disposition = download || fileInfo.kind === "other" ? "attachment" : "inline";
    headers["Content-Disposition"] =
      `${disposition}; filename*=UTF-8''${encodeRFC5987(relPath.split("/").pop() ?? relPath)}`;
    const stream = Readable.toWeb(
      fs.createReadStream(blobPath(entry.sha256)),
    ) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, { headers });
  }

  const relPath = segments?.length
    ? segments.map((s) => decodeURIComponent(s)).join("/")
    : share.entryPath;
  if (!isValidSharePath(relPath)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // 清单校验：path 必须在 share_files 里——否则磁盘上有也不给读
  const fileRow = getDb()
    .select()
    .from(shareFiles)
    .where(and(eq(shareFiles.shareId, share.id), eq(shareFiles.path, relPath)))
    .get();
  if (!fileRow) return new NextResponse("Not Found", { status: 404 });

  const stat = await statFile(share.id, relPath);
  if (!stat) return new NextResponse("Not Found", { status: 404 });

  // 响应头策略按文件本身定（css/js 在 html share 里也是 text），不是 share.kind
  const fileInfo = classifyFile(relPath);
  const headers = rawContentHeaders({
    kind: fileInfo.kind,
    mimeType: fileRow.mimeType,
  });
  headers["Content-Length"] = String(stat.size);
  headers["Cache-Control"] = share.passwordHash
    ? "private, no-store"
    : "public, max-age=300";

  const download = request.nextUrl.searchParams.get("download") === "1";
  const disposition = download || fileInfo.kind === "other" ? "attachment" : "inline";
  headers["Content-Disposition"] =
    `${disposition}; filename*=UTF-8''${encodeRFC5987(relPath.split("/").pop() ?? relPath)}`;

  const stream = Readable.toWeb(
    readFileStream(share.id, relPath),
  ) as ReadableStream<Uint8Array>;
  return new NextResponse(stream, { headers });
}
