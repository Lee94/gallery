"use server";

import { refresh, revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isValidSharePath, saveFile } from "@/lib/storage";
import { resolveShareAccess } from "@/lib/share-access";
import {
  MAX_SHARE_EDITOR_FILE_BYTES,
  addShareOwnerCommentFor,
  clearShareKvCollectionFor,
  deleteShareFileFor,
  deleteShareFor,
  findOwnedShare,
  forkShareFor,
  moveShareFor,
  publishShareVersionFor,
  removeSharePasswordFor,
  resetSharePageStateFor,
  resetShareVisitorStateFor,
  resetShareDataSpaceFor,
  rollbackShareVersionFor,
  setShareCommentsEnabledFor,
  setShareAttachmentsEnabledFor,
  setShareCommentsVisitorWriteFor,
  setShareCommentStatusFor,
  setShareDataSchemaVersionFor,
  setShareExpiryFor,
  setShareKvEnabledFor,
  setShareKvPolicyFor,
  setShareLlmEnabledFor,
  setShareMetadataFor,
  setSharePageStateEnabledFor,
  setSharePasswordFor,
  setSharePinnedFor,
  setShareVisitorStateEnabledFor,
  upsertShareFileFor,
  type ShareMetadataInput,
} from "@/lib/shares/manage";
import type { CommentStatus } from "@/lib/shares/comments";
import type { KvPolicy } from "@/lib/shares/kv";

export type ShareActionResult = { error?: string };

function completeMutation<T extends ShareActionResult>(shareId: string, result: T): T {
  if (!result.error) {
    revalidatePath("/dashboard");
    // Server Action 可能在详情页调用；refresh 让当前路由也拿到新数据。
    refresh();
  }
  return result;
}

// 分享管理的浏览器入口：认证走 cookie session，业务逻辑复用 src/lib/shares/manage.ts，
// 变更成功后 revalidatePath 刷新 dashboard。MCP 工具复用同一份 manage.* 逻辑（认证走 Bearer）。

export async function setSharePassword(
  shareId: string,
  password: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = await setSharePasswordFor(user.id, shareId, password);
  return completeMutation(shareId, res);
}

export async function removeSharePassword(
  shareId: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = removeSharePasswordFor(user.id, shareId);
  return completeMutation(shareId, res);
}

/** expiresAt 为 unix 毫秒；null 表示清除过期时间 */
export async function setShareExpiry(
  shareId: string,
  expiresAt: number | null,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = setShareExpiryFor(user.id, shareId, expiresAt);
  return completeMutation(shareId, res);
}

export async function setSharePageStateEnabled(
  shareId: string,
  enabled: boolean,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = setSharePageStateEnabledFor(user.id, shareId, enabled);
  return completeMutation(shareId, res);
}

export async function resetSharePageState(
  shareId: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = resetSharePageStateFor(user.id, shareId);
  return completeMutation(shareId, res);
}

export async function setShareVisitorStateEnabled(
  shareId: string,
  enabled: boolean,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = setShareVisitorStateEnabledFor(user.id, shareId, enabled);
  return completeMutation(shareId, res);
}

export async function resetShareVisitorState(
  shareId: string,
  visitorKey?: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  const res = resetShareVisitorStateFor(user.id, shareId, visitorKey);
  return completeMutation(shareId, res);
}

export async function setShareKvEnabled(
  shareId: string,
  enabled: boolean,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, setShareKvEnabledFor(user.id, shareId, enabled));
}

export async function setShareCommentsEnabled(
  shareId: string,
  enabled: boolean,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, setShareCommentsEnabledFor(user.id, shareId, enabled));
}

export async function setShareAttachmentsEnabled(
  shareId: string,
  enabled: boolean,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, setShareAttachmentsEnabledFor(user.id, shareId, enabled));
}

export async function setShareLlmEnabled(
  shareId: string,
  enabled: boolean,
  dailyTokenBudget: number | null,
  model: string | null,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(
    shareId,
    setShareLlmEnabledFor(user.id, shareId, { enabled, dailyTokenBudget, model }),
  );
}

export async function setShareCommentsVisitorWrite(
  shareId: string,
  enabled: boolean,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(
    shareId,
    setShareCommentsVisitorWriteFor(user.id, shareId, enabled),
  );
}

export async function setShareKvPolicy(
  shareId: string,
  policy: KvPolicy,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, setShareKvPolicyFor(user.id, shareId, policy));
}

export async function setShareDataSchemaVersion(
  shareId: string,
  version: number,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, setShareDataSchemaVersionFor(user.id, shareId, version));
}

export async function resetShareDataSpace(
  shareId: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, resetShareDataSpaceFor(user.id, shareId));
}

export async function clearShareKvCollection(
  shareId: string,
  collection: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(
    shareId,
    clearShareKvCollectionFor(user.id, shareId, collection),
  );
}

export async function moderateShareComment(
  shareId: string,
  commentId: string,
  status: CommentStatus,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(
    shareId,
    setShareCommentStatusFor(user.id, shareId, commentId, status),
  );
}

export async function replyToShare(
  shareId: string,
  body: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, addShareOwnerCommentFor(user.id, shareId, body));
}

export async function publishShareVersion(
  shareId: string,
  label: string,
  dataMode: "keep" | "new" = "keep",
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(
    shareId,
    await publishShareVersionFor(user.id, shareId, label, dataMode),
  );
}

export async function rollbackShareVersion(
  shareId: string,
  versionNo: number,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(
    shareId,
    await rollbackShareVersionFor(user.id, shareId, versionNo),
  );
}

export async function setShareMetadata(
  shareId: string,
  metadata: ShareMetadataInput,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, setShareMetadataFor(user.id, shareId, metadata));
}

export async function setSharePinned(
  shareId: string,
  pinned: boolean,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, setSharePinnedFor(user.id, shareId, pinned));
}

export async function moveShare(
  shareId: string,
  direction: -1 | 1,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, moveShareFor(user.id, shareId, direction));
}

export async function forkShare(slug: string): Promise<ShareActionResult & { slug?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录后再 Fork" };
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") return { error: "分享不存在" };
  if (access.status === "locked") return { error: "请先输入分享访问密码" };
  return forkShareFor(user.id, access.share.id);
}

export async function saveShareTextFile(
  shareId: string,
  path: string,
  content: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  if (typeof path !== "string" || typeof content !== "string") {
    return { error: "文件参数不正确" };
  }
  if (!isValidSharePath(path)) return { error: "非法文件路径" };
  const found = findOwnedShare(user.id, shareId);
  if ("error" in found) return found;
  const buf = Buffer.from(content, "utf8");
  if (buf.length === 0) return { error: "文件内容为空" };
  if (buf.length > MAX_SHARE_EDITOR_FILE_BYTES) {
    return { error: "在线编辑文件不能超过 512KB，请通过上传或 MCP 更新大文件" };
  }
  await saveFile(shareId, path, buf);
  return completeMutation(shareId, await upsertShareFileFor(user.id, shareId, path, buf.length));
}

export async function deleteShareFile(
  shareId: string,
  path: string,
): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, await deleteShareFileFor(user.id, shareId, path));
}

export async function deleteShare(shareId: string): Promise<ShareActionResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "请先登录" };
  return completeMutation(shareId, await deleteShareFor(user.id, shareId));
}
