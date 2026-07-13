import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { rawContentHeaders } from "@/lib/file-kind";
import { resolveShareAccess } from "@/lib/share-access";
import { readFileStream, statFile } from "@/lib/storage";

function encodeRFC5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (access.status === "locked") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { share } = access;
  const stat = await statFile(share.id);
  if (!stat) return new NextResponse("Not Found", { status: 404 });

  const headers = rawContentHeaders(share);
  headers["Content-Length"] = String(stat.size);
  headers["Cache-Control"] = share.passwordHash
    ? "private, no-store"
    : "public, max-age=300";

  const download = request.nextUrl.searchParams.get("download") === "1";
  const disposition =
    download || share.kind === "other" ? "attachment" : "inline";
  headers["Content-Disposition"] =
    `${disposition}; filename*=UTF-8''${encodeRFC5987(share.originalName)}`;

  const stream = Readable.toWeb(
    readFileStream(share.id),
  ) as ReadableStream<Uint8Array>;
  return new NextResponse(stream, { headers });
}
