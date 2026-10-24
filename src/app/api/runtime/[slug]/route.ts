import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { rawContentHeaders } from "@/lib/file-kind";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { resolveShareAccess } from "@/lib/share-access";
import { listShareFiles } from "@/lib/shares/manage";
import { buildReactArtifact, type ReactSourceFile } from "@/lib/shares/react-runtime";
import { blobPath, getVersionManifest } from "@/lib/shares/versions";
import { readFile } from "@/lib/storage";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") return Response.json({ error: "不可用" }, { status: 404 });
  if (access.status === "locked") return Response.json({ error: "请先输入访问密码" }, { status: 403 });
  if (access.share.runtime !== "react") return Response.json({ error: "不是 React Artifact" }, { status: 404 });
  const ip = await getClientIp();
  if (!rateLimit(`react-build:${ip}:${access.share.id}`, 30, 60_000)) {
    return Response.json({ error: "构建请求过于频繁" }, { status: 429 });
  }

  const rawVersion = request.nextUrl.searchParams.get("v");
  const versionNo = rawVersion === null ? null : Number(rawVersion);
  if (versionNo !== null && (!Number.isSafeInteger(versionNo) || versionNo < 1)) {
    return Response.json({ error: "版本号不正确" }, { status: 400 });
  }
  let files: ReactSourceFile[];
  try {
    if (versionNo === null) {
      files = await Promise.all(listShareFiles(access.share.id).map(async (file) => ({
        path: file.path,
        content: new Uint8Array(await readFile(access.share.id, file.path)),
      })));
    } else {
      const manifest = getVersionManifest(access.share.id, versionNo);
      if (!manifest) return Response.json({ error: "版本不存在" }, { status: 404 });
      files = await Promise.all(manifest.map(async (file) => ({
        path: file.path,
        content: new Uint8Array(await fsp.readFile(blobPath(file.sha256))),
      })));
    }
  } catch {
    return Response.json({ error: "源文件不可用" }, { status: 500 });
  }
  const html = await buildReactArtifact({
    files,
    entryPath: access.share.entryPath,
    runtimeVersion: access.share.runtimeVersion,
  });
  return new Response(html, {
    headers: {
      ...rawContentHeaders({ kind: "html", mimeType: "text/html" }),
      "Cache-Control": "private, no-store",
      "X-Gallery-React-Version": access.share.runtimeVersion,
    },
  });
}
