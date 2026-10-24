import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "@/db";
import { publishShareEvent } from "@/lib/share-events";
import {
  shareCommentBans,
  shareComments,
  type ShareComment,
} from "@/db/schema";

export type CommentStatus = "open" | "resolved" | "hidden";

export interface CommentItem {
  id: string;
  shareId: string;
  visitorKey: string | null;
  authorLabel: string;
  body: string;
  isOwner: boolean;
  status: CommentStatus;
  createdAt: number;
  resolvedAt: number | null;
}

function toItem(row: ShareComment): CommentItem {
  return {
    id: row.id,
    shareId: row.shareId,
    visitorKey: row.visitorKey,
    authorLabel: row.authorLabel,
    body: row.body,
    isOwner: row.isOwner,
    status: row.status as CommentStatus,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export function listComments(
  shareId: string,
  opts: { includeHidden?: boolean } = {},
): CommentItem[] {
  const rows = getDb()
    .select()
    .from(shareComments)
    .where(eq(shareComments.shareId, shareId))
    .orderBy(asc(shareComments.createdAt))
    .all();
  return rows
    .map(toItem)
    .filter((c) => opts.includeHidden || c.status !== "hidden");
}

export function getComment(
  shareId: string,
  commentId: string,
): CommentItem | null {
  const row = getDb()
    .select()
    .from(shareComments)
    .where(
      and(
        eq(shareComments.shareId, shareId),
        eq(shareComments.id, commentId),
      ),
    )
    .get();
  return row ? toItem(row) : null;
}

export function isVisitorBanned(shareId: string, visitorKey: string): boolean {
  return (
    getDb()
      .select()
      .from(shareCommentBans)
      .where(
        and(
          eq(shareCommentBans.shareId, shareId),
          eq(shareCommentBans.visitorKey, visitorKey),
        ),
      )
      .get() !== undefined
  );
}

export function addComment(input: {
  shareId: string;
  visitorKey: string | null;
  authorLabel: string;
  body: string;
  isOwner: boolean;
}): CommentItem {
  const now = Date.now();
  const id = nanoid(16);
  const row = {
    id,
    shareId: input.shareId,
    visitorKey: input.visitorKey,
    authorLabel: input.authorLabel.slice(0, 40) || "访客",
    body: input.body,
    isOwner: input.isOwner,
    status: "open" as const,
    createdAt: now,
    resolvedAt: null,
  };
  getDb().insert(shareComments).values(row).run();
  publishShareEvent(input.shareId, "comments");
  return toItem(row);
}

export function setCommentStatus(
  shareId: string,
  commentId: string,
  status: CommentStatus,
): boolean {
  const res = getDb()
    .update(shareComments)
    .set({
      status,
      resolvedAt: status === "resolved" ? Date.now() : null,
    })
    .where(
      and(
        eq(shareComments.shareId, shareId),
        eq(shareComments.id, commentId),
      ),
    )
    .run();
  if (res.changes > 0) publishShareEvent(shareId, "comments");
  return res.changes > 0;
}

export function banVisitor(shareId: string, visitorKey: string): void {
  getDb()
    .insert(shareCommentBans)
    .values({ shareId, visitorKey, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export function unbanVisitor(shareId: string, visitorKey: string): void {
  getDb()
    .delete(shareCommentBans)
    .where(
      and(
        eq(shareCommentBans.shareId, shareId),
        eq(shareCommentBans.visitorKey, visitorKey),
      ),
    )
    .run();
}

export function listBans(shareId: string): string[] {
  return getDb()
    .select({ v: shareCommentBans.visitorKey })
    .from(shareCommentBans)
    .where(eq(shareCommentBans.shareId, shareId))
    .all()
    .map((r) => r.v);
}
