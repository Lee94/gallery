import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { fileTooLargeMessage, getEnv } from "@/lib/env";
import { isValidOrigin } from "@/lib/request-origin";
import { createShare, type ShareFileInput } from "@/lib/shares/create";
import { isValidSharePath } from "@/lib/storage";

/**
 * 浏览器上传入口。两种模式：
 *  - 单文件：form.get("file") 一个 File，按文件名扩展名定 kind（旧行为）
 *  - 多文件 artifact：form.getAll("files") 多个 File + form.get("entryPath")，
 *    每个 File 的 webkitRelativePath（目录上传）或 name（多选）作为 share 内 path
 */
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
  const pageStateEnabled = form.get("pageStateEnabled") === "true";
  const visitorStateEnabled = form.get("visitorStateEnabled") === "true";
  const runtime = form.get("runtime") === "react" ? "react" : "static";

  // —— 多文件模式 ——
  const multiFiles = form.getAll("files").filter((f): f is File => f instanceof File);
  if (multiFiles.length > 0) {
    if (multiFiles.length > 255) {
      return NextResponse.json({ error: "一次最多上传 255 个文件" }, { status: 400 });
    }
    const entryPath = (form.get("entryPath") as string | null)?.trim() || "index.html";
    if (!isValidSharePath(entryPath)) {
      return NextResponse.json({ error: "入口路径非法" }, { status: 400 });
    }

    const files: ShareFileInput[] = [];
    for (const file of multiFiles) {
      // webkitRelativePath 只在目录上传时存在且带顶层目录；剥掉第一层保留内部结构。
      // 其他场景（多选、程序构造的 File）用 file.name，它本身可能就是 "js/app.js"。
      const withRel = file as File & { webkitRelativePath?: string };
      const rel = withRel.webkitRelativePath
        ? withRel.webkitRelativePath.split("/").slice(1).join("/") || file.name
        : file.name;
      if (!isValidSharePath(rel)) {
        return NextResponse.json({ error: `非法文件路径：${rel}` }, { status: 400 });
      }
      if (file.size === 0) {
        return NextResponse.json({ error: `文件 ${rel} 内容为空` }, { status: 400 });
      }
      if (file.size > env.maxFileSizeBytes) {
        return NextResponse.json({ error: fileTooLargeMessage() }, { status: 413 });
      }
      files.push({ path: rel, content: file.stream(), size: file.size });
    }
    if (!files.some((f) => f.path === entryPath)) {
      return NextResponse.json(
        { error: `入口文件 ${entryPath} 不在上传列表中` },
        { status: 400 },
      );
    }

    const { slug, url, share } = await createShare({
      ownerId: user.id,
      filename: entryPath,
      files,
      entryPath,
      runtime,
      pageStateEnabled,
      visitorStateEnabled,
    });
    return NextResponse.json({
      slug,
      url,
      pageStateEnabled: share.pageStateEnabled,
      visitorStateEnabled: share.visitorStateEnabled,
    });
  }

  // —— 单文件模式（旧路径） ——
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
    runtime,
    pageStateEnabled,
    visitorStateEnabled,
  });

  return NextResponse.json({
    slug,
    url,
    pageStateEnabled: share.pageStateEnabled,
    visitorStateEnabled: share.visitorStateEnabled,
  });
}
