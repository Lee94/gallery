import { Zip, ZipPassThrough } from "fflate";
import type { NextRequest } from "next/server";
import { resolveShareAccess } from "@/lib/share-access";
import { listShareFiles } from "@/lib/shares/manage";
import { readFile } from "@/lib/storage";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") {
    return Response.json({ error: "分享不可用", code: "not_found" }, { status: 404 });
  }
  if (access.status === "locked") {
    return Response.json({ error: "请先输入分享访问密码", code: "locked" }, { status: 403 });
  }
  const files = listShareFiles(access.share.id);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cancelled = false;
      request.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
      const zip = new Zip((error, chunk, final) => {
        if (error) controller.error(error);
        else if (!cancelled) {
          controller.enqueue(chunk);
          if (final) controller.close();
        }
      });
      try {
        for (const file of files) {
          if (cancelled) return;
          const entry = new ZipPassThrough(file.path);
          zip.add(entry);
          entry.push(new Uint8Array(await readFile(access.share.id, file.path)), true);
        }
        zip.end();
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${access.share.slug}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
