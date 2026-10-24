import { nanoid } from "nanoid";
import { getDb } from "@/db";
import {
  shareFiles,
  sharePageStates,
  shares,
  type Share,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { classifyFile } from "@/lib/file-kind";
import { generateSlug } from "@/lib/slug";
import {
  deleteShareDir,
  isValidSharePath,
  saveFile,
} from "@/lib/storage";
import { snapshotInitialVersion } from "@/lib/shares/versions";
import { REACT_RUNTIME_VERSION } from "@/lib/runtime-config";

export interface ShareFileInput {
  /** share 内部相对路径（"index.html" / "js/app.js"），经 isValidSharePath 校验 */
  path: string;
  content: ReadableStream<Uint8Array> | Uint8Array;
  size: number;
}

export interface CreateShareInput {
  ownerId: string;
  /** 入口文件名（如 "index.html"），用于推导 share.kind 和展示名 */
  filename: string;
  title?: string | null;
  description?: string;
  icon?: string;
  coverPath?: string | null;
  sourceEnabled?: boolean;
  forkedFromSlug?: string | null;
  /** 单文件上传的便捷字段；与 files 二选一 */
  content?: ReadableStream<Uint8Array> | Uint8Array;
  size?: number;
  /** 多文件上传：files 优先于 content/filename 单文件路径 */
  files?: ShareFileInput[];
  /** 多文件时指定入口 path，默认 "index.html"；单文件时强制等于 filename 清洗结果 */
  entryPath?: string;
  runtime?: "static" | "react";
  runtimeVersion?: string;
  passwordHash?: string | null;
  expiresAt?: number | null;
  /** 仅对 HTML 生效；其他类型保持 false */
  pageStateEnabled?: boolean;
  /** 仅对 HTML 生效；其他类型保持 false */
  visitorStateEnabled?: boolean;
  kvEnabled?: boolean;
  attachmentsEnabled?: boolean;
  commentsEnabled?: boolean;
  commentsVisitorWrite?: boolean;
  llmEnabled?: boolean;
  llmDailyTokenBudget?: number | null;
  llmModel?: string | null;
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
 * 创建一个分享：清洗文件名 → 校验所有 path → 落盘（tmp+rename）→ 写库 + 生成 slug（冲突重试）。
 * 文件先落盘、后写库，写库失败补偿删整个 share 目录。
 * 供 multipart 上传 route 与 MCP 工具共用。
 */
export async function createShare(input: CreateShareInput): Promise<CreatedShare> {
  const env = getEnv();
  const id = nanoid(16);
  const now = Date.now();

  // —— 规整输入：单文件便捷字段 → files[] ——
  let files: ShareFileInput[];
  if (input.files && input.files.length > 0) {
    files = input.files;
  } else if (input.content !== undefined && input.size !== undefined) {
    const cleaned =
      input.filename.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) ||
      "index.html";
    files = [{ path: cleaned, content: input.content, size: input.size }];
  } else {
    throw new Error("必须提供 content+size 或 files[]");
  }

  // —— 校验路径 ——
  for (const f of files) {
    if (!isValidSharePath(f.path)) {
      throw new Error(`非法文件路径：${f.path}`);
    }
    if (f.size <= 0) {
      throw new Error(`文件 ${f.path} 内容为空`);
    }
  }
  // 去重：同一 path 出现两次视为非法
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`重复的文件路径：${f.path}`);
    seen.add(f.path);
  }

  // —— 确定入口与 share 级元数据 ——
  const entryPath = input.entryPath ?? (files.length === 1 ? files[0]!.path : "index.html");
  const entry = files.find((f) => f.path === entryPath);
  if (!entry) {
    throw new Error(`入口文件 ${entryPath} 不在上传文件列表中`);
  }
  const runtime = input.runtime ?? "static";
  const runtimeVersion = input.runtimeVersion ?? REACT_RUNTIME_VERSION;
  if (runtime === "react") {
    if (!/\.(jsx|tsx)$/i.test(entryPath)) throw new Error("React Artifact 入口必须是 .jsx 或 .tsx");
    if (runtimeVersion !== REACT_RUNTIME_VERSION) {
      throw new Error(`仅支持锁定的 React ${REACT_RUNTIME_VERSION} 运行时`);
    }
  }
  const classified = classifyFile(entryPath);
  const kind = runtime === "react" ? "html" : classified.kind;
  const mimeType = runtime === "react" ? "text/html" : classified.mimeType;
  // share.originalName 沿用语义"对外展示的文件名"：取入口文件名最后一段
  const originalName =
    entryPath.split("/").pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) ||
    "untitled";

  const pageStateEnabled = kind === "html" && input.pageStateEnabled === true;
  const visitorStateEnabled =
    kind === "html" && input.visitorStateEnabled === true;
  const kvEnabled = kind === "html" && input.kvEnabled === true;
  const commentsEnabled = input.commentsEnabled === true; // 评论不限 HTML
  const llmEnabled = kind === "html" && input.llmEnabled === true;

  // —— 落盘 ——
  try {
    for (const f of files) {
      const stream =
        f.content instanceof Uint8Array ? bytesToStream(f.content) : f.content;
      await saveFile(id, f.path, stream);
    }
  } catch (e) {
    await deleteShareDir(id);
    throw e;
  }

  // —— 写库 ——
  const db = getDb();
  for (let attempt = 0; ; attempt++) {
    const slug = generateSlug();
    const shareValues = {
      id,
      ownerId: input.ownerId,
      slug,
      originalName,
      title: input.title ?? null,
      description: input.description ?? "",
      icon: input.icon ?? "",
      coverPath: input.coverPath ?? null,
      sourceEnabled: input.sourceEnabled ?? true,
      pinned: false,
      sortOrder: 0,
      forkedFromSlug: input.forkedFromSlug ?? null,
      mimeType,
      size: entry.size,
      kind,
      runtime,
      runtimeVersion,
      entryPath,
      passwordHash: input.passwordHash ?? null,
      passwordVersion: 0,
      expiresAt: input.expiresAt ?? null,
      pageStateEnabled,
      visitorStateEnabled,
      kvEnabled,
      attachmentsEnabled: kind === "html" && input.attachmentsEnabled === true,
      commentsEnabled,
      commentsVisitorWrite: input.commentsVisitorWrite ?? true,
      llmEnabled,
      dataGeneration: 1,
      dataSchemaVersion: 1,
      llmDailyTokenBudget: input.llmDailyTokenBudget ?? null,
      llmModel: input.llmModel ?? null,
      createdAt: now,
      updatedAt: now,
    } satisfies Share;
    try {
      db.transaction((tx) => {
        tx.insert(shares).values(shareValues).run();
        for (const f of files) {
          const { mimeType: fMime } = classifyFile(f.path);
          tx.insert(shareFiles)
            .values({
              shareId: id,
              path: f.path,
              mimeType: fMime,
              sizeBytes: f.size,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        if (pageStateEnabled) {
          tx.insert(sharePageStates).values({
            shareId: id,
            dataJson: "null",
            version: 0,
            sizeBytes: 4,
            updatedAt: now,
          }).run();
        }
      });
      // v1 版本快照（初版）；失败不阻塞创建
      const created: CreatedShare = {
        slug,
        url: `${env.appUrl}/s/${slug}`,
        share: shareValues,
      };
      try {
        await snapshotInitialVersion(shareValues);
      } catch (e) {
        console.error("snapshot initial version failed:", e);
      }
      return created;
    } catch (e) {
      if (isSlugTaken(e) && attempt < 3) continue;
      await deleteShareDir(id);
      throw e;
    }
  }
}
