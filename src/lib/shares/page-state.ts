import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { sharePageStates, type SharePageState } from "@/db/schema";

export interface PageStateSnapshot {
  data: unknown;
  version: number;
  sizeBytes: number;
  updatedAt: number;
}

export type SavePageStateResult =
  | { status: "ok"; snapshot: PageStateSnapshot }
  | { status: "conflict"; snapshot: PageStateSnapshot }
  | { status: "not_found" };

function toSnapshot(row: SharePageState): PageStateSnapshot {
  return {
    // 只有服务端 JSON.stringify 成功的内容才能写入，因此这里必定是合法 JSON
    data: JSON.parse(row.dataJson) as unknown,
    version: row.version,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
  };
}

export function getPageStateSnapshot(shareId: string): PageStateSnapshot | null {
  const row = getDb()
    .select()
    .from(sharePageStates)
    .where(eq(sharePageStates.shareId, shareId))
    .get();
  return row ? toSnapshot(row) : null;
}

/**
 * 用单条条件 UPDATE 实现 compare-and-swap；并发写同一版本时只有一个能成功。
 * dataJson 必须由调用方 stringify 并完成字节数校验。
 */
export function savePageState(
  shareId: string,
  baseVersion: number,
  dataJson: string,
  sizeBytes: number,
): SavePageStateResult {
  const db = getDb();
  const result = db
    .update(sharePageStates)
    .set({
      dataJson,
      sizeBytes,
      version: sql`${sharePageStates.version} + 1`,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(sharePageStates.shareId, shareId),
        eq(sharePageStates.version, baseVersion),
      ),
    )
    .run();

  const snapshot = getPageStateSnapshot(shareId);
  if (!snapshot) return { status: "not_found" };
  return result.changes === 1
    ? { status: "ok", snapshot }
    : { status: "conflict", snapshot };
}
