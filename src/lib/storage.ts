import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getEnv } from "./env";

// 磁盘布局：files/<shareId>/<path>。shareId/path 都由服务端校验后拼接，
// 此处的前缀断言是纵深防御（防止路径穿越到 files/ 外）。
function assertInside(dir: string, p: string): string {
  const resolved = path.resolve(p);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error(`path escapes storage dir: ${p}`);
  }
  return resolved;
}

export function shareDir(shareId: string): string {
  const env = getEnv();
  return assertInside(env.filesDir, path.join(env.filesDir, shareId));
}

export function filePathFor(shareId: string, relPath: string): string {
  const dir = shareDir(shareId);
  return assertInside(dir, path.join(dir, relPath));
}

/**
 * share 内部相对路径的合法性校验：不允许绝对路径、`..`、反斜杠、空段、控制字符。
 * 上传/更新文件、写 share_files 行前必须过这里；raw 路由解析子路径时也用它挡穿越。
 */
export function isValidSharePath(relPath: string): boolean {
  if (!relPath || relPath.length > 512) return false;
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return false;
  if (relPath.includes("\\")) return false;
  if (/[\x00-\x1f\x7f]/.test(relPath)) return false;
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return false;
  }
  return true;
}

/** 先写 tmp 再 rename，保证 files/ 下不会出现写了一半的文件。目标目录递归创建。 */
export async function saveFile(
  shareId: string,
  relPath: string,
  stream: ReadableStream<Uint8Array> | Uint8Array,
): Promise<void> {
  const body =
    stream instanceof Uint8Array
      ? new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(stream);
            c.close();
          },
        })
      : stream;
  const env = getEnv();
  const target = filePathFor(shareId, relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.mkdir(env.tmpDir, { recursive: true });
  // tmp 文件名带上 shareId+path 哈希，避免并发上传同名文件互相覆盖
  const tmpName = `${shareId}-${Buffer.from(relPath).toString("base64url")}`;
  const tmpPath = assertInside(env.tmpDir, path.join(env.tmpDir, tmpName));
  try {
    await pipeline(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      fs.createWriteStream(tmpPath, { flags: "wx" }),
    );
    await fsp.rename(tmpPath, target);
  } catch (e) {
    await fsp.rm(tmpPath, { force: true });
    throw e;
  }
}

/** 删除单个文件；失败只记日志（DB 行已删，孤儿文件可接受） */
export async function deleteFile(
  shareId: string,
  relPath: string,
): Promise<void> {
  try {
    await fsp.unlink(filePathFor(shareId, relPath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`failed to delete file ${shareId}/${relPath}:`, e);
    }
  }
}

/** 删除整个 share 目录（删分享时用） */
export async function deleteShareDir(shareId: string): Promise<void> {
  try {
    await fsp.rm(shareDir(shareId), { recursive: true, force: true });
  } catch (e) {
    console.error(`failed to delete share dir ${shareId}:`, e);
  }
}

export async function statFile(
  shareId: string,
  relPath: string,
): Promise<fs.Stats | null> {
  try {
    const stat = await fsp.stat(filePathFor(shareId, relPath));
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

export function readFileStream(
  shareId: string,
  relPath: string,
): fs.ReadStream {
  return fs.createReadStream(filePathFor(shareId, relPath));
}

export function attachmentPathFor(id: string): string {
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) throw new Error("invalid attachment id");
  const dir = getEnv().attachmentsDir;
  return assertInside(dir, path.join(dir, id));
}

export async function saveAttachment(id: string, content: Uint8Array): Promise<void> {
  const target = attachmentPathFor(id);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, { flag: "wx" });
}

export async function readAttachment(id: string): Promise<Buffer> {
  return fsp.readFile(attachmentPathFor(id));
}

export async function deleteAttachment(id: string): Promise<void> {
  try {
    await fsp.unlink(attachmentPathFor(id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`failed to delete attachment ${id}:`, e);
    }
  }
}

export async function readFile(shareId: string, relPath: string): Promise<Buffer> {
  return fsp.readFile(filePathFor(shareId, relPath));
}

/** 预览页读小文本文件用（markdown / text） */
export async function readFileText(
  shareId: string,
  relPath: string,
): Promise<string> {
  return fsp.readFile(filePathFor(shareId, relPath), "utf-8");
}
