import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getEnv } from "./env";

// 磁盘路径只由服务端生成的 nanoid 构成；此处的前缀断言是纵深防御
function assertInside(dir: string, p: string): string {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error(`path escapes storage dir: ${p}`);
  }
  return resolved;
}

export function filePathFor(id: string): string {
  const env = getEnv();
  return assertInside(env.filesDir, path.join(env.filesDir, id));
}

/** 先写 tmp 再 rename，保证 files/ 下不会出现写了一半的文件 */
export async function saveFile(
  id: string,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const env = getEnv();
  await fsp.mkdir(env.filesDir, { recursive: true });
  await fsp.mkdir(env.tmpDir, { recursive: true });
  const tmpPath = assertInside(env.tmpDir, path.join(env.tmpDir, id));
  try {
    await pipeline(
      Readable.fromWeb(stream as WebReadableStream<Uint8Array>),
      fs.createWriteStream(tmpPath, { flags: "wx" }),
    );
    await fsp.rename(tmpPath, filePathFor(id));
  } catch (e) {
    await fsp.rm(tmpPath, { force: true });
    throw e;
  }
}

/** 删除失败只记日志（DB 行已删，孤儿文件可接受） */
export async function deleteFile(id: string): Promise<void> {
  try {
    await fsp.unlink(filePathFor(id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`failed to delete file ${id}:`, e);
    }
  }
}

export async function statFile(id: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(filePathFor(id));
  } catch {
    return null;
  }
}

export function readFileStream(id: string): fs.ReadStream {
  return fs.createReadStream(filePathFor(id));
}

/** 预览页读小文本文件用（markdown / text） */
export async function readFileText(id: string): Promise<string> {
  return fsp.readFile(filePathFor(id), "utf-8");
}
