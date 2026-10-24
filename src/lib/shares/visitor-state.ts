import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { shareVisitorStates, type ShareVisitorState } from "@/db/schema";

export interface VisitorStateSnapshot {
  data: unknown;
  version: number;
  sizeBytes: number;
  updatedAt: number;
}

export type SaveVisitorStateResult =
  | { status: "ok"; snapshot: VisitorStateSnapshot }
  | { status: "conflict"; snapshot: VisitorStateSnapshot }
  | { status: "not_found" };

function toSnapshot(row: ShareVisitorState): VisitorStateSnapshot {
  return {
    data: JSON.parse(row.dataJson) as unknown,
    version: row.version,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
  };
}

export function getVisitorStateSnapshot(
  shareId: string,
  visitorKey: string,
): VisitorStateSnapshot | null {
  const row = getDb()
    .select()
    .from(shareVisitorStates)
    .where(
      and(
        eq(shareVisitorStates.shareId, shareId),
        eq(shareVisitorStates.visitorKey, visitorKey),
      ),
    )
    .get();
  return row ? toSnapshot(row) : null;
}

/**
 * CAS 写入访客数据：行不存在则插入 version=1，存在则要求 baseVersion 匹配。
 * 并发写同一 visitorKey 时只有一个成功，失败者拿到最新快照走 update 重试。
 */
export function saveVisitorState(
  shareId: string,
  visitorKey: string,
  baseVersion: number,
  dataJson: string,
  sizeBytes: number,
): SaveVisitorStateResult {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .select({ version: shareVisitorStates.version })
    .from(shareVisitorStates)
    .where(
      and(
        eq(shareVisitorStates.shareId, shareId),
        eq(shareVisitorStates.visitorKey, visitorKey),
      ),
    )
    .get();

  if (!existing) {
    // 首次写入要求 baseVersion=0；否则视为并发冲突（别人先建了行）
    if (baseVersion !== 0) {
      const snapshot = getVisitorStateSnapshot(shareId, visitorKey);
      return snapshot
        ? { status: "conflict", snapshot }
        : { status: "not_found" };
    }
    db.insert(shareVisitorStates)
      .values({
        shareId,
        visitorKey,
        dataJson,
        sizeBytes,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const snapshot = getVisitorStateSnapshot(shareId, visitorKey);
    return snapshot
      ? { status: "ok", snapshot }
      : { status: "not_found" };
  }

  const result = db
    .update(shareVisitorStates)
    .set({
      dataJson,
      sizeBytes,
      version: sql`${shareVisitorStates.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(shareVisitorStates.shareId, shareId),
        eq(shareVisitorStates.visitorKey, visitorKey),
        eq(shareVisitorStates.version, baseVersion),
      ),
    )
    .run();

  const snapshot = getVisitorStateSnapshot(shareId, visitorKey);
  if (!snapshot) return { status: "not_found" };
  return result.changes === 1
    ? { status: "ok", snapshot }
    : { status: "conflict", snapshot };
}
