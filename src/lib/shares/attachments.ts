import { and, eq, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "@/db";
import {
  shareAttachments,
  type AttachmentVisibility,
  type ShareAttachment,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { publishShareEvent } from "@/lib/share-events";

export interface AttachmentView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  visibility: AttachmentVisibility;
  isMine: boolean;
  createdAt: number;
}

export function toAttachmentView(
  item: ShareAttachment,
  actorKey: string,
  isOwner: boolean,
): AttachmentView {
  return {
    id: item.id,
    name: item.originalName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    visibility: item.visibility,
    isMine: isOwner || item.creatorKey === actorKey,
    createdAt: item.createdAt,
  };
}

export function listAttachments(
  shareId: string,
  actorKey: string,
  isOwner: boolean,
): AttachmentView[] {
  const where = isOwner
    ? eq(shareAttachments.shareId, shareId)
    : and(
        eq(shareAttachments.shareId, shareId),
        or(
          eq(shareAttachments.visibility, "shared"),
          eq(shareAttachments.creatorKey, actorKey),
        ),
      );
  const items = getDb()
    .select()
    .from(shareAttachments)
    .where(where)
    .orderBy(shareAttachments.createdAt)
    .all();
  return items.map((item) => toAttachmentView(item, actorKey, isOwner));
}

export function getAccessibleAttachment(
  shareId: string,
  attachmentId: string,
  actorKey: string,
  isOwner: boolean,
): ShareAttachment | null {
  const item = getDb()
    .select()
    .from(shareAttachments)
    .where(
      and(eq(shareAttachments.shareId, shareId), eq(shareAttachments.id, attachmentId)),
    )
    .get();
  if (!item) return null;
  if (!isOwner && item.visibility !== "shared" && item.creatorKey !== actorKey) return null;
  return item;
}

export function reserveAttachment(input: {
  shareId: string;
  creatorKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  visibility: AttachmentVisibility;
}): ShareAttachment | { error: string; status: number } {
  const limits = getEnv().attachmentLimits;
  if (input.sizeBytes < 0 || input.sizeBytes > limits.fileBytes) {
    return { error: "附件超过单文件大小限制", status: 413 };
  }
  const db = getDb();
  const totals = db
    .select({
      shareBytes: sql<number>`coalesce(sum(${shareAttachments.sizeBytes}), 0)`,
      visitorBytes: sql<number>`coalesce(sum(case when ${shareAttachments.creatorKey} = ${input.creatorKey} then ${shareAttachments.sizeBytes} else 0 end), 0)`,
    })
    .from(shareAttachments)
    .where(eq(shareAttachments.shareId, input.shareId))
    .get();
  if ((totals?.shareBytes ?? 0) + input.sizeBytes > limits.shareBytes) {
    return { error: "此分享的附件总配额已用尽", status: 413 };
  }
  if ((totals?.visitorBytes ?? 0) + input.sizeBytes > limits.visitorBytes) {
    return { error: "你的附件配额已用尽，请删除旧附件后重试", status: 413 };
  }

  const id = nanoid(21);
  // 检查与插入之间没有 await，同一实例内的并发上传不会同时越过配额检查。
  db.insert(shareAttachments)
    .values({ id, ...input, createdAt: Date.now() })
    .run();
  publishShareEvent(input.shareId, "attachments");
  return db.select().from(shareAttachments).where(eq(shareAttachments.id, id)).get()!;
}

export function releaseAttachment(shareId: string, attachmentId: string): void {
  getDb()
    .delete(shareAttachments)
    .where(and(eq(shareAttachments.shareId, shareId), eq(shareAttachments.id, attachmentId)))
    .run();
  publishShareEvent(shareId, "attachments");
}
