import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { fileTooLargeMessage, getEnv } from "@/lib/env";
import { isValidOrigin } from "@/lib/request-origin";
import { createShare } from "@/lib/shares/create";

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
    return NextResponse.json({ error: fileTooLargeMessage() }, { status: 413 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "缺少文件" }, { status: 400 });
  }
  if (file.size > env.maxFileSizeBytes) {
    return NextResponse.json({ error: fileTooLargeMessage() }, { status: 413 });
  }

  const { slug, url, share } = await createShare({
    ownerId: user.id,
    filename: file.name,
    content: file.stream(),
    size: file.size,
    pageStateEnabled: form.get("pageStateEnabled") === "true",
  });

  return NextResponse.json({ slug, url, pageStateEnabled: share.pageStateEnabled });
}
