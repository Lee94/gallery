import { nanoid } from "nanoid";
import { getDb } from "@/db";
import { shares, type Share } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { classifyFile } from "@/lib/file-kind";
import { generateSlug } from "@/lib/slug";
import { deleteFile, saveFile } from "@/lib/storage";

export interface CreateShareInput {
  ownerId: string;
  filename: string; // 原始文件名（含扩展名），内部会清洗
  content: ReadableStream<Uint8Array> | Uint8Array; // multipart 传 stream，MCP 传 Buffer
  size: number; // 字节数（调用方负责在读入前做大小上限校验）
  passwordHash?: string | null;
  expiresAt?: number | null;
}

export interface CreatedShare {
  slug: string;
  url: string;
  share: Share;
}

// 唯一约束冲突（slug 撞车）识别，用于重试；其余错误直接抛出并清理孤儿文件
function isSlugTaken(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return `${e.message} ${cause}`.includes("UNIQUE constraint failed: shares.slug");
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * 创建一个分享：清洗文件名 → 按扩展名判类型 → 落盘（tmp+rename）→ 写库 + 生成 slug（冲突重试）。
 * 文件先落盘、后写库，写库失败补偿删文件（与 storage 之间无事务，靠先写后清理维持一致性）。
 * 供 multipart 上传 route 与 MCP 工具共用——两条路径唯一的差别只是 content 是 stream 还是 Buffer。
 */
export async function createShare(input: CreateShareInput): Promise<CreatedShare> {
  const env = getEnv();
  const originalName =
    input.filename.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || "untitled";
  const { kind, mimeType } = classifyFile(originalName);
  const id = nanoid(16);

  const stream =
    input.content instanceof Uint8Array
      ? bytesToStream(input.content)
      : input.content;
  await saveFile(id, stream);

  const db = getDb();
  const now = Date.now();
  for (let attempt = 0; ; attempt++) {
    const slug = generateSlug();
    const values = {
      id,
      ownerId: input.ownerId,
      slug,
      originalName,
      mimeType,
      size: input.size,
      kind,
      passwordHash: input.passwordHash ?? null,
      passwordVersion: 0,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
    } satisfies Share;
    try {
      db.insert(shares).values(values).run();
      return { slug, url: `${env.appUrl}/s/${slug}`, share: values };
    } catch (e) {
      if (isSlugTaken(e) && attempt < 3) continue;
      await deleteFile(id);
      throw e;
    }
  }
}
