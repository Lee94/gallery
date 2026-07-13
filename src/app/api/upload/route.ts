import { NextResponse, type NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { getDb } from "@/db";
import { shares } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getEnv } from "@/lib/env";
import { classifyFile } from "@/lib/file-kind";
import { generateSlug } from "@/lib/slug";
import { deleteFile, saveFile } from "@/lib/storage";

// route handler 没有 Server Action 的内建 Origin 校验，手动做（防 CSRF）
function isValidOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (origin === getEnv().appUrl) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

function isSlugTaken(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return `${e.message} ${cause}`.includes("UNIQUE constraint failed: shares.slug");
}

export async function POST(request: NextRequest) {
  const env = getEnv();

  if (!isValidOrigin(request)) {
    return NextResponse.json({ error: "非法请求来源" }, { status: 403 });
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  // 预检 Content-Length，超限直接拒绝，不读 body（1MB 余量给 multipart 边界）
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > env.maxFileSizeBytes + 1024 * 1024) {
    return NextResponse.json(
      { error: `文件超过大小限制（${env.maxFileSizeBytes / 1024 / 1024}MB）` },
      { status: 413 },
    );
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "缺少文件" }, { status: 400 });
  }
  if (file.size > env.maxFileSizeBytes) {
    return NextResponse.json(
      { error: `文件超过大小限制（${env.maxFileSizeBytes / 1024 / 1024}MB）` },
      { status: 413 },
    );
  }

  const originalName =
    file.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || "untitled";
  const { kind, mimeType } = classifyFile(originalName);
  const id = nanoid(16);

  await saveFile(id, file.stream());

  const db = getDb();
  const now = Date.now();
  let slug = "";
  for (let attempt = 0; ; attempt++) {
    slug = generateSlug();
    try {
      db.insert(shares)
        .values({
          id,
          ownerId: user.id,
          slug,
          originalName,
          mimeType,
          size: file.size,
          kind,
          createdAt: now,
        })
        .run();
      break;
    } catch (e) {
      if (isSlugTaken(e) && attempt < 3) continue;
      await deleteFile(id);
      throw e;
    }
  }

  return NextResponse.json({ slug, url: `${env.appUrl}/s/${slug}` });
}
