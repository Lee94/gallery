import { and, asc, eq, gt, like, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "@/db";
import {
  shareKv,
  shareKvPolicies,
  type KvAccessMode,
  type ShareKv,
  type ShareKvPolicy,
} from "@/db/schema";
import { publishShareEvent } from "@/lib/share-events";

// collection 与 key 的合法性：相对宽松但挡控制字符；长度收紧防滥用
const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const KEY_RE = /^[^\x00-\x1f\x7f/\\]{1,256}$/;

export function isValidCollection(name: string): boolean {
  return COLLECTION_RE.test(name);
}
export function isValidKvKey(key: string): boolean {
  return KEY_RE.test(key);
}

export interface KvItem {
  collection: string;
  key: string;
  value: unknown;
  version: number;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export type KvResult<T> =
  | { status: "ok"; item: T }
  | { status: "conflict"; item: T }
  | { status: "not_found" };

function toItem(row: ShareKv): KvItem {
  return {
    collection: row.collection,
    key: row.key,
    value: JSON.parse(row.valueJson) as unknown,
    version: row.version,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function kvGetRecord(
  shareId: string,
  collection: string,
  key: string,
): { item: KvItem; creatorKey: string | null } | null {
  const row = getDb()
    .select()
    .from(shareKv)
    .where(
      and(
        eq(shareKv.shareId, shareId),
        eq(shareKv.collection, collection),
        eq(shareKv.key, key),
      ),
    )
    .get();
  return row ? { item: toItem(row), creatorKey: row.creatorKey } : null;
}

export function kvGet(
  shareId: string,
  collection: string,
  key: string,
): KvItem | null {
  return kvGetRecord(shareId, collection, key)?.item ?? null;
}

export interface KvListOptions {
  prefix?: string;
  /** 上次 list 返回的最后一个 key；下一次 list 从这里继续 */
  cursor?: string;
  limit?: number; // 默认 100，最大 500
}

export function kvList(
  shareId: string,
  collection: string,
  opts: KvListOptions = {},
): { items: KvItem[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds: SQL[] = [
    eq(shareKv.shareId, shareId),
    eq(shareKv.collection, collection),
  ];
  if (opts.prefix) {
    // 前缀匹配：like 需要转义 %/_
    const escaped = opts.prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(like(shareKv.key, `${escaped}%`));
  }
  if (opts.cursor) conds.push(gt(shareKv.key, opts.cursor));

  const rows = getDb()
    .select()
    .from(shareKv)
    .where(and(...conds))
    .orderBy(asc(shareKv.key))
    .limit(limit + 1)
    .all();

  const items = rows.slice(0, limit).map(toItem);
  const nextCursor =
    rows.length > limit ? items[items.length - 1]!.key : null;
  return { items, nextCursor };
}

export interface KvPutInput {
  /** 提供则 CAS：必须等于当前 version；不提供则 upsert */
  baseVersion?: number;
  /** 提供则要求行不存在（create-only） */
  ifAbsent?: boolean;
  /** 新行的创建者，用于 creator ACL；更新已有行时不会改变创建者。 */
  creatorKey?: string | null;
  /** batch 内部关闭单行事件，事务提交后统一发送。 */
  emitEvent?: boolean;
}

export function kvPut(
  shareId: string,
  collection: string,
  key: string,
  valueJson: string,
  sizeBytes: number,
  opts: KvPutInput = {},
): KvResult<KvItem> {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(shareKv)
    .where(
      and(
        eq(shareKv.shareId, shareId),
        eq(shareKv.collection, collection),
        eq(shareKv.key, key),
      ),
    )
    .get();

  if (opts.ifAbsent && existing) {
    return { status: "conflict", item: toItem(existing) };
  }
  if (
    opts.baseVersion !== undefined &&
    (!existing || existing.version !== opts.baseVersion)
  ) {
    return existing
      ? { status: "conflict", item: toItem(existing) }
      : { status: "not_found" };
  }

  if (!existing) {
    db.insert(shareKv)
      .values({
        shareId,
        collection,
        key,
        valueJson,
        creatorKey: opts.creatorKey ?? null,
        sizeBytes,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } else {
    db.update(shareKv)
      .set({
        valueJson,
        sizeBytes,
        version: sql`${shareKv.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(shareKv.shareId, shareId),
          eq(shareKv.collection, collection),
          eq(shareKv.key, key),
        ),
      )
      .run();
  }
  const item = kvGet(shareId, collection, key);
  if (item && opts.emitEvent !== false) {
    publishShareEvent(shareId, "kv", { collection, key, version: item.version });
  }
  return item ? { status: "ok", item } : { status: "not_found" };
}

export function kvDelete(
  shareId: string,
  collection: string,
  key: string,
  baseVersion?: number,
  emitEvent = true,
): { status: "ok" } | { status: "conflict"; item: KvItem } | { status: "not_found" } {
  const db = getDb();
  const existing = kvGet(shareId, collection, key);
  if (!existing) return { status: "not_found" };
  if (baseVersion !== undefined && existing.version !== baseVersion) {
    return { status: "conflict", item: existing };
  }
  db.delete(shareKv)
    .where(
      and(
        eq(shareKv.shareId, shareId),
        eq(shareKv.collection, collection),
        eq(shareKv.key, key),
      ),
    )
    .run();
  if (emitEvent) publishShareEvent(shareId, "kv", { collection, key, version: existing.version });
  return { status: "ok" };
}

export interface KvBatchOp {
  op: "put" | "del";
  collection: string;
  key: string;
  /** put 时需要；序列化后的 JSON 字符串 */
  valueJson?: string;
  sizeBytes?: number;
  baseVersion?: number;
  ifAbsent?: boolean;
  creatorKey?: string | null;
}

export interface KvBatchResult {
  index: number;
  op: "put" | "del";
  collection: string;
  key: string;
  status: "ok" | "conflict" | "not_found";
  item?: KvItem;
}

/**
 * 批量执行：单事务内顺序执行所有 op。任一 op 失败只标该 op 的 status，
 * 不回滚其他 op（调用方逐条处理失败重试，语义更接近 ArtifactData.batch）。
 */
export function kvBatch(shareId: string, ops: KvBatchOp[]): KvBatchResult[] {
  const db = getDb();
  const results: KvBatchResult[] = [];
  db.transaction(() => {
    ops.forEach((op, index) => {
      if (op.op === "put") {
        if (op.valueJson === undefined || op.sizeBytes === undefined) {
          results.push({
            index,
            op: "put",
            collection: op.collection,
            key: op.key,
            status: "not_found",
          });
          return;
        }
        const r = kvPut(shareId, op.collection, op.key, op.valueJson, op.sizeBytes, {
          baseVersion: op.baseVersion,
          ifAbsent: op.ifAbsent,
          creatorKey: op.creatorKey,
          emitEvent: false,
        });
        results.push({
          index,
          op: "put",
          collection: op.collection,
          key: op.key,
          status: r.status === "ok" ? "ok" : r.status === "conflict" ? "conflict" : "not_found",
          item: "item" in r ? r.item : undefined,
        });
      } else {
        const r = kvDelete(shareId, op.collection, op.key, op.baseVersion, false);
        results.push({
          index,
          op: "del",
          collection: op.collection,
          key: op.key,
          status: r.status,
          item: "item" in r ? r.item : undefined,
        });
      }
    });
  });
  for (const result of results) {
    if (result.status === "ok") {
      publishShareEvent(shareId, "kv", {
        collection: result.collection,
        key: result.key,
        version: result.item?.version,
      });
    }
  }
  return results;
}

/** owner 侧：清空一个 collection（所有行删除）。返回删除的行数。 */
export function kvClearCollection(shareId: string, collection: string): number {
  const res = getDb()
    .delete(shareKv)
    .where(
      and(eq(shareKv.shareId, shareId), eq(shareKv.collection, collection)),
    )
    .run();
  if (res.changes > 0) publishShareEvent(shareId, "kv", { collection });
  return res.changes;
}

export function kvCountRows(shareId: string): number {
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(shareKv)
    .where(eq(shareKv.shareId, shareId))
    .get();
  return row?.n ?? 0;
}

export interface KvPolicy {
  collection: string;
  readMode: KvAccessMode;
  writeMode: KvAccessMode;
  deleteMode: KvAccessMode;
}

export function canReadKvPolicy(policy: KvPolicy, isOwner: boolean): boolean {
  return isOwner || policy.readMode === "all";
}

export function canMutateKvPolicy(
  policy: KvPolicy,
  mode: "write" | "delete",
  isOwner: boolean,
  actorKey: string | null,
  creatorKey: string | null,
): boolean {
  if (isOwner) return true;
  const accessMode = mode === "write" ? policy.writeMode : policy.deleteMode;
  if (accessMode === "all") return true;
  if (accessMode === "owner") return false;
  return actorKey !== null && creatorKey === actorKey;
}

export function getKvPolicy(shareId: string, collection: string): KvPolicy {
  const row = getDb()
    .select()
    .from(shareKvPolicies)
    .where(
      and(
        eq(shareKvPolicies.shareId, shareId),
        eq(shareKvPolicies.collection, collection),
      ),
    )
    .get();
  return toKvPolicy(collection, row);
}

function toKvPolicy(collection: string, row?: ShareKvPolicy): KvPolicy {
  return {
    collection,
    readMode: row?.readMode ?? "all",
    writeMode: row?.writeMode ?? "all",
    deleteMode: row?.deleteMode ?? "all",
  };
}

export function setKvPolicy(
  shareId: string,
  policy: KvPolicy,
): void {
  getDb()
    .insert(shareKvPolicies)
    .values({ shareId, ...policy, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [shareKvPolicies.shareId, shareKvPolicies.collection],
      set: {
        readMode: policy.readMode,
        writeMode: policy.writeMode,
        deleteMode: policy.deleteMode,
        updatedAt: Date.now(),
      },
    })
    .run();
  publishShareEvent(shareId, "kv", { collection: policy.collection });
}

export function newKvKey(): string {
  return nanoid(16);
}
