import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import {
  shareFiles,
  shareAttachments,
  shareKv,
  sharePageStates,
  shares,
  shareVisitorStates,
  type Share,
  type ShareFile,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getEnv } from "@/lib/env";
import { publishShareEvent } from "@/lib/share-events";
import { classifyFile } from "@/lib/file-kind";
import { createShare } from "@/lib/shares/create";
import { deleteAttachment, deleteFile, deleteShareDir, isValidSharePath, readFile } from "@/lib/storage";
import {
  isValidCollection,
  kvClearCollection,
  setKvPolicy,
  type KvPolicy,
} from "@/lib/shares/kv";
import { addComment, setCommentStatus, type CommentStatus } from "@/lib/shares/comments";
import { rollbackToVersion, snapshotVersion } from "@/lib/shares/versions";

// 分享的所有权校验 + 变更逻辑，按显式 userId 工作（不依赖 cookies）。
// Server Actions（src/actions/shares.ts）与 MCP 工具（src/lib/mcp/tools.ts）共用同一份，
// 保证两条入口的授权与副作用完全一致。revalidatePath 之类 Next 专属副作用留在 action 层。

export type ShareMutation = { error?: string };

// 浏览器 Server Action 默认请求体上限为 1MB；在线编辑限制在 512KB，留出编码与协议开销。
export const MAX_SHARE_EDITOR_FILE_BYTES = 512 * 1024;

type Found = { share: Share } | { error: string };

// 不存在与非本人所有统一同一句提示（不区分，避免泄露他人分享是否存在）
function findOwned(userId: string, condition: SQL): Found {
  const share = getDb().select().from(shares).where(condition).get();
  if (!share || share.ownerId !== userId) return { error: "分享不存在或无权操作" };
  return { share };
}

export function findOwnedShare(userId: string, shareId: string): Found {
  return findOwned(userId, eq(shares.id, shareId));
}

/** MCP 工具对外只认 slug（公开标识），内部据此解析出带 owner 校验的 share。 */
export function findOwnedShareBySlug(userId: string, slug: string): Found {
  return findOwned(userId, eq(shares.slug, slug));
}

export function listSharesFor(userId: string): Share[] {
  return getDb()
    .select()
    .from(shares)
    .where(eq(shares.ownerId, userId))
    .orderBy(desc(shares.pinned), asc(shares.sortOrder), desc(shares.updatedAt))
    .all();
}

export function listShareFiles(shareId: string): ShareFile[] {
  return getDb()
    .select()
    .from(shareFiles)
    .where(eq(shareFiles.shareId, shareId))
    .orderBy(shareFiles.path)
    .all();
}

export async function setSharePasswordFor(
  userId: string,
  shareId: string,
  password: string,
): Promise<ShareMutation> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!password || password.length > 200) return { error: "密码不能为空" };

  const passwordHash = await hashPassword(password);
  getDb()
    .update(shares)
    .set({ passwordHash, passwordVersion: sql`${shares.passwordVersion} + 1` })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

export function removeSharePasswordFor(
  userId: string,
  shareId: string,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;

  getDb()
    .update(shares)
    .set({ passwordHash: null, passwordVersion: sql`${shares.passwordVersion} + 1` })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

export interface ShareMetadataInput {
  title: string | null;
  description: string;
  icon: string;
  coverPath: string | null;
  sourceEnabled: boolean;
}

export function setShareMetadataFor(
  userId: string,
  shareId: string,
  input: ShareMetadataInput,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (
    typeof input.title !== "string" && input.title !== null ||
    typeof input.description !== "string" ||
    typeof input.icon !== "string" ||
    typeof input.sourceEnabled !== "boolean"
  ) {
    return { error: "元数据格式不正确" };
  }
  const title = input.title?.trim() || null;
  const description = input.description.trim();
  const icon = input.icon.trim();
  if ((title?.length ?? 0) > 120 || description.length > 500 || icon.length > 16) {
    return { error: "标题、描述或图标超过长度限制" };
  }
  if (input.coverPath !== null) {
    const cover = getDb()
      .select()
      .from(shareFiles)
      .where(and(eq(shareFiles.shareId, shareId), eq(shareFiles.path, input.coverPath)))
      .get();
    if (!cover || !cover.mimeType.startsWith("image/") || cover.mimeType === "image/svg+xml") {
      return { error: "封面必须是分享内的 PNG/JPEG/GIF/WebP 图片" };
    }
  }
  getDb().update(shares).set({
    title,
    description,
    icon,
    coverPath: input.coverPath,
    sourceEnabled: input.sourceEnabled,
    updatedAt: Date.now(),
  }).where(eq(shares.id, shareId)).run();
  return {};
}

export function setSharePinnedFor(userId: string, shareId: string, pinned: boolean): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  getDb().update(shares).set({ pinned }).where(eq(shares.id, shareId)).run();
  return {};
}

export function moveShareFor(userId: string, shareId: string, direction: -1 | 1): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  const ordered = listSharesFor(userId);
  const index = ordered.findIndex((share) => share.id === shareId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) return {};
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  getDb().transaction((tx) => {
    ordered.forEach((share, sortOrder) => {
      tx.update(shares).set({ sortOrder }).where(eq(shares.id, share.id)).run();
    });
  });
  return {};
}

/** Fork 只复制当前公开内容和能力配置；数据、附件、评论、密码与历史版本不复制。 */
export async function forkShareFor(
  userId: string,
  sourceShareId: string,
): Promise<ShareMutation & { slug?: string }> {
  const source = getDb().select().from(shares).where(eq(shares.id, sourceShareId)).get();
  if (!source) return { error: "源分享不存在" };
  const files = listShareFiles(source.id);
  try {
    const contents = await Promise.all(files.map(async (file) => ({
      path: file.path,
      content: new Uint8Array(await readFile(source.id, file.path)),
      size: file.sizeBytes,
    })));
    const created = await createShare({
      ownerId: userId,
      filename: source.originalName,
      title: `${source.title ?? source.originalName} · Remix`.slice(0, 120),
      description: source.description,
      icon: source.icon,
      coverPath: source.coverPath,
      sourceEnabled: source.sourceEnabled,
      forkedFromSlug: source.slug,
      files: contents,
      entryPath: source.entryPath,
      runtime: source.runtime,
      runtimeVersion: source.runtimeVersion,
      pageStateEnabled: source.pageStateEnabled,
      visitorStateEnabled: source.visitorStateEnabled,
      kvEnabled: source.kvEnabled,
      attachmentsEnabled: source.attachmentsEnabled,
      commentsEnabled: source.commentsEnabled,
      commentsVisitorWrite: source.commentsVisitorWrite,
      llmEnabled: source.llmEnabled,
      llmDailyTokenBudget: source.llmDailyTokenBudget,
      llmModel: source.llmModel,
    });
    return { slug: created.slug };
  } catch {
    return { error: "Fork 失败，源文件可能不可用" };
  }
}

/** expiresAt 为 unix 毫秒；null 表示清除过期时间 */
export function setShareExpiryFor(
  userId: string,
  shareId: string,
  expiresAt: number | null,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (expiresAt !== null) {
    if (!Number.isFinite(expiresAt)) return { error: "时间格式不正确" };
    if (expiresAt <= Date.now()) return { error: "过期时间必须晚于现在" };
  }

  getDb().update(shares).set({ expiresAt }).where(eq(shares.id, shareId)).run();
  return {};
}

export function setSharePageStateEnabledFor(
  userId: string,
  shareId: string,
  enabled: boolean,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (enabled && found.share.kind !== "html") {
    return { error: "只有 HTML 分享可以启用共享页面数据" };
  }

  const db = getDb();
  db.transaction((tx) => {
    tx.update(shares)
      .set({ pageStateEnabled: enabled })
      .where(eq(shares.id, shareId))
      .run();
    if (enabled) {
      // 重新启用时保留旧数据；首次启用则创建版本 0 的空快照
      tx.insert(sharePageStates)
        .values({
          shareId,
          dataJson: "null",
          version: 0,
          sizeBytes: 4,
          updatedAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();
    }
  });
  return {};
}

export function resetSharePageStateFor(
  userId: string,
  shareId: string,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!found.share.pageStateEnabled) return { error: "共享页面数据未启用" };

  const now = Date.now();
  getDb()
    .insert(sharePageStates)
    .values({ shareId, dataJson: "null", version: 1, sizeBytes: 4, updatedAt: now })
    .onConflictDoUpdate({
      target: sharePageStates.shareId,
      set: {
        dataJson: "null",
        sizeBytes: 4,
        version: sql`${sharePageStates.version} + 1`,
        updatedAt: now,
      },
    })
    .run();
  publishShareEvent(shareId, "page-state");
  return {};
}

export function setShareVisitorStateEnabledFor(
  userId: string,
  shareId: string,
  enabled: boolean,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (enabled && found.share.kind !== "html") {
    return { error: "只有 HTML 分享可以启用访客数据" };
  }

  getDb()
    .update(shares)
    .set({ visitorStateEnabled: enabled })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

/**
 * 清空访客数据。visitorKey 给定时只清该访客；省略时清整份分享的所有访客数据。
 * 每条被清的行 version+1，让持有旧 baseVersion 的客户端写入冲突。
 */
export function resetShareVisitorStateFor(
  userId: string,
  shareId: string,
  visitorKey?: string,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!found.share.visitorStateEnabled) return { error: "访客数据未启用" };

  const db = getDb();
  const now = Date.now();
  const cond = visitorKey
    ? and(
        eq(shareVisitorStates.shareId, shareId),
        eq(shareVisitorStates.visitorKey, visitorKey),
      )
    : eq(shareVisitorStates.shareId, shareId);

  // SQLite 没有 bulk "UPDATE ... SET version = version + 1, dataJson = 'null'"
  // 的 upsert 简写，按行处理（数量上 visitor 行远小于文件量）。
  const rows = db
    .select({ shareId: shareVisitorStates.shareId, visitorKey: shareVisitorStates.visitorKey })
    .from(shareVisitorStates)
    .where(cond)
    .all();
  for (const r of rows) {
    db.update(shareVisitorStates)
      .set({
        dataJson: "null",
        sizeBytes: 4,
        version: sql`${shareVisitorStates.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(shareVisitorStates.shareId, r.shareId),
          eq(shareVisitorStates.visitorKey, r.visitorKey),
        ),
      )
      .run();
  }
  return {};
}

/** 启停行级共享数据；停用只关闭访问，不删除已有行。 */
export function setShareKvEnabledFor(
  userId: string,
  shareId: string,
  enabled: boolean,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (enabled && found.share.kind !== "html") {
    return { error: "只有 HTML 分享可以启用行集数据" };
  }
  getDb().update(shares).set({ kvEnabled: enabled }).where(eq(shares.id, shareId)).run();
  return {};
}

export function setShareAttachmentsEnabledFor(
  userId: string,
  shareId: string,
  enabled: boolean,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (enabled && found.share.kind !== "html") {
    return { error: "只有 HTML 分享可以启用访客附件" };
  }
  getDb().update(shares).set({ attachmentsEnabled: enabled }).where(eq(shares.id, shareId)).run();
  return {};
}

export function setShareCommentsEnabledFor(
  userId: string,
  shareId: string,
  enabled: boolean,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  getDb()
    .update(shares)
    .set({ commentsEnabled: enabled })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

export function setShareCommentsVisitorWriteFor(
  userId: string,
  shareId: string,
  enabled: boolean,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  getDb()
    .update(shares)
    .set({ commentsVisitorWrite: enabled })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

export function setShareKvPolicyFor(
  userId: string,
  shareId: string,
  policy: KvPolicy,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!isValidCollection(policy.collection)) return { error: "非法 collection" };
  const modes = ["all", "owner", "creator"] as const;
  if (
    !modes.includes(policy.readMode) ||
    !modes.includes(policy.writeMode) ||
    !modes.includes(policy.deleteMode) ||
    policy.readMode === "creator"
  ) {
    return { error: "KV 权限模式不正确" };
  }
  setKvPolicy(shareId, policy);
  return {};
}

export function setShareDataSchemaVersionFor(
  userId: string,
  shareId: string,
  dataSchemaVersion: number,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!Number.isSafeInteger(dataSchemaVersion) || dataSchemaVersion < 1) {
    return { error: "数据 schema 版本必须是正整数" };
  }
  getDb()
    .update(shares)
    .set({ dataSchemaVersion })
    .where(eq(shares.id, shareId))
    .run();
  publishShareEvent(shareId, "page-state", {
    dataGeneration: found.share.dataGeneration,
    dataSchemaVersion,
  });
  return {};
}

/** 新建数据空间：清空页面/访客/KV 数据并递增 generation，旧页面会收到版本冲突而不是写错空间。 */
export function resetShareDataSpaceFor(
  userId: string,
  shareId: string,
): ShareMutation & { dataGeneration?: number } {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  const db = getDb();
  const dataGeneration = found.share.dataGeneration + 1;
  db.transaction((tx) => {
    tx.delete(sharePageStates).where(eq(sharePageStates.shareId, shareId)).run();
    tx.delete(shareVisitorStates).where(eq(shareVisitorStates.shareId, shareId)).run();
    tx.delete(shareKv).where(eq(shareKv.shareId, shareId)).run();
    tx.update(shares)
      .set({ dataGeneration, dataSchemaVersion: 1 })
      .where(eq(shares.id, shareId))
      .run();
    if (found.share.pageStateEnabled) {
      tx.insert(sharePageStates)
        .values({
          shareId,
          dataJson: "null",
          version: 0,
          sizeBytes: 4,
          updatedAt: Date.now(),
        })
        .run();
    }
  });
  publishShareEvent(shareId, "page-state", {
    version: 0,
    dataGeneration,
    dataSchemaVersion: 1,
  });
  publishShareEvent(shareId, "kv", { dataGeneration, dataSchemaVersion: 1 });
  return { dataGeneration };
}

export function setShareLlmEnabledFor(
  userId: string,
  shareId: string,
  input: {
    enabled: boolean;
    dailyTokenBudget?: number | null;
    model?: string | null;
  },
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (input.enabled && found.share.kind !== "html") {
    return { error: "只有 HTML 分享可以启用 LLM" };
  }
  if (input.enabled && !getEnv().llm) {
    return { error: "服务端未配置 LLM（LLM_BASE_URL/LLM_API_KEY）" };
  }
  if (
    input.dailyTokenBudget !== undefined &&
    input.dailyTokenBudget !== null &&
    (!Number.isSafeInteger(input.dailyTokenBudget) || input.dailyTokenBudget <= 0)
  ) {
    return { error: "每日 token 配额必须是正整数" };
  }
  if (
    input.model !== undefined &&
    input.model !== null &&
    typeof input.model !== "string"
  ) {
    return { error: "模型名称不正确" };
  }
  const model = input.model?.trim() ?? "";
  if (model.length > 100 || /[\x00-\x1f\x7f]/.test(model)) {
    return { error: "模型名称不正确" };
  }

  getDb()
    .update(shares)
    .set({
      llmEnabled: input.enabled,
      ...(input.dailyTokenBudget !== undefined
        ? { llmDailyTokenBudget: input.dailyTokenBudget }
        : {}),
      ...(input.model !== undefined ? { llmModel: model || null } : {}),
    })
    .where(eq(shares.id, shareId))
    .run();
  return {};
}

/** 清空 collection 是 owner 管理操作；公开 KV 写接口不应复用这个入口。 */
export function clearShareKvCollectionFor(
  userId: string,
  shareId: string,
  collection: string,
): ShareMutation & { cleared?: number } {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!found.share.kvEnabled) return { error: "行集数据未启用" };
  if (!isValidCollection(collection)) return { error: "非法 collection" };
  return { cleared: kvClearCollection(shareId, collection) };
}

export function setShareCommentStatusFor(
  userId: string,
  shareId: string,
  commentId: string,
  status: CommentStatus,
): ShareMutation {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!["open", "resolved", "hidden"].includes(status)) return { error: "评论状态不正确" };
  if (!setCommentStatus(shareId, commentId, status)) return { error: "评论不存在" };
  return {};
}

export function addShareOwnerCommentFor(
  userId: string,
  shareId: string,
  body: string,
): ShareMutation & { commentId?: string } {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!found.share.commentsEnabled) return { error: "评论未启用" };
  if (typeof body !== "string") return { error: "评论内容不正确" };
  const text = body.trim();
  if (!text || text.length > 2000) return { error: "评论长度应为 1–2000 字符" };
  const comment = addComment({
    shareId,
    visitorKey: null,
    authorLabel: "站长",
    body: text,
    isOwner: true,
  });
  return { commentId: comment.id };
}

export async function publishShareVersionFor(
  userId: string,
  shareId: string,
  label: string,
  dataMode: "keep" | "new" = "keep",
): Promise<ShareMutation & { versionNo?: number; dataGeneration?: number }> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (typeof label !== "string") return { error: "版本标签不正确" };
  const normalized = label.trim();
  if (!normalized || normalized.length > 100) {
    return { error: "版本标签长度应为 1–100 字符" };
  }
  if (dataMode !== "keep" && dataMode !== "new") return { error: "数据处理模式不正确" };
  let dataGeneration: number | undefined;
  if (dataMode === "new") {
    const reset = resetShareDataSpaceFor(userId, shareId);
    if (reset.error) return reset;
    dataGeneration = reset.dataGeneration;
  }
  const versionNo = await snapshotVersion(found.share, normalized);
  return { versionNo, dataGeneration };
}

export async function rollbackShareVersionFor(
  userId: string,
  shareId: string,
  versionNo: number,
): Promise<ShareMutation & { versionNo?: number }> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!Number.isSafeInteger(versionNo) || versionNo < 1) return { error: "版本号不正确" };
  const result = await rollbackToVersion(found.share, versionNo);
  if ("error" in result) return result;
  return { versionNo: result.versionNo };
}

/**
 * 更新 share 内单个文件的内容（覆盖已存在 path 或新增 path）。
 * 入口文件被更新时同步刷新 share.mimeType/kind/originalName/updatedAt。
 * 调用方负责大小校验、内容已是字节流。
 */
export async function upsertShareFileFor(
  userId: string,
  shareId: string,
  path: string,
  sizeBytes: number,
): Promise<ShareMutation & { isNew?: boolean; isEntry?: boolean }> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!isValidSharePath(path)) return { error: "非法文件路径" };

  const db = getDb();
  const { mimeType } = classifyFile(path);
  const now = Date.now();
  const isEntry = found.share.entryPath === path;
  const existing = db
    .select()
    .from(shareFiles)
    .where(and(eq(shareFiles.shareId, shareId), eq(shareFiles.path, path)))
    .get();
  const { kind } = classifyFile(path);
  if (isEntry && found.share.runtime === "static" && kind !== found.share.kind) {
    return { error: `入口文件类型不能从 ${found.share.kind} 变为 ${kind}` };
  }

  // 落盘已发生：先快照改后的状态为一版（版本 = "变更后"）
  // 注意：snapshotVersion 读磁盘 manifest，因此必须在调用方 saveFile 完成、
  // DB 行更新之前调用——否则会把"已更新文件 + 旧 DB 行"的快照记歪。
  // 这里先 DB 更新，再快照。
  db.transaction((tx) => {
    if (existing) {
      tx.update(shareFiles)
        .set({ mimeType, sizeBytes, updatedAt: now })
        .where(
          and(eq(shareFiles.shareId, shareId), eq(shareFiles.path, path)),
        )
        .run();
    } else {
      tx.insert(shareFiles)
        .values({
          shareId,
          path,
          mimeType,
          sizeBytes,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    tx.update(shares)
      .set({
        updatedAt: now,
        ...(isEntry
          ? {
              size: sizeBytes,
              mimeType: found.share.runtime === "react" ? "text/html" : mimeType,
              originalName:
                path.split("/").pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) ||
                found.share.originalName,
            }
          : {}),
      })
      .where(eq(shares.id, shareId))
      .run();
  });

  // 版本快照：记录「本次变更之后」的状态。调用方已先落盘，这里磁盘与 DB 已同步。
  // 失败只记日志，不阻塞变更（版本历史是尽力而为的辅助功能）。
  try {
    const refreshed = db
      .select()
      .from(shares)
      .where(eq(shares.id, shareId))
      .get();
    if (refreshed) await snapshotVersion(refreshed);
  } catch (e) {
    console.error("snapshot after upsert failed:", e);
  }

  return { isNew: !existing, isEntry };
}

/**
 * 从多文件 share 里删除一个 path。入口文件不允许删（会破坏整个 share）。
 */
export async function deleteShareFileFor(
  userId: string,
  shareId: string,
  path: string,
): Promise<ShareMutation> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;
  if (!isValidSharePath(path)) return { error: "非法文件路径" };
  if (found.share.entryPath === path) {
    return { error: "不能删除入口文件；如需删除请删除整个分享" };
  }

  const res = getDb()
    .delete(shareFiles)
    .where(and(eq(shareFiles.shareId, shareId), eq(shareFiles.path, path)))
    .run();
  if (res.changes === 0) return { error: "文件不存在" };
  await deleteFile(shareId, path);
  getDb()
    .update(shares)
    .set({ updatedAt: Date.now() })
    .where(eq(shares.id, shareId))
    .run();

  // 版本快照：记录删除后的新状态
  try {
    const refreshed = getDb()
      .select()
      .from(shares)
      .where(eq(shares.id, shareId))
      .get();
    if (refreshed) await snapshotVersion(refreshed);
  } catch (e) {
    console.error("snapshot after delete failed:", e);
  }
  return {};
}

export async function deleteShareFor(
  userId: string,
  shareId: string,
): Promise<ShareMutation> {
  const found = findOwnedShare(userId, shareId);
  if ("error" in found) return found;

  // 先删 DB 行（此后链接立即 404），文件删除失败只记日志
  const attachments = getDb()
    .select({ id: shareAttachments.id })
    .from(shareAttachments)
    .where(eq(shareAttachments.shareId, shareId))
    .all();
  getDb().delete(shares).where(eq(shares.id, shareId)).run();
  await deleteShareDir(shareId);
  await Promise.all(attachments.map((item) => deleteAttachment(item.id)));
  return {};
}
