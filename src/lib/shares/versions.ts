import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "@/db";
import {
  shareBlobs,
  shareFiles,
  shares,
  shareVersions,
  type Share,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { publishShareEvent } from "@/lib/share-events";
import { classifyFile } from "@/lib/file-kind";
import {
  deleteFile,
  filePathFor,
  isValidSharePath,
  saveFile,
} from "@/lib/storage";

// 版本保留上限：每 share 最多 50 个版本；超出清理最老的并回收无引用 blob
const MAX_VERSIONS_PER_SHARE = 50;

export interface ManifestEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

function blobsDir(): string {
  return path.join(getEnv().dataDir, "blobs");
}

function blobPathFor(sha256: string): string {
  const dir = path.join(blobsDir(), sha256.slice(0, 2));
  return path.join(dir, sha256);
}

async function writeBlobIfAbsent(
  sha256: string,
  sourcePath: string,
  sizeBytes: number,
): Promise<void> {
  const target = blobPathFor(sha256);
  try {
    await fsp.stat(target);
    return; // 已存在
  } catch {}
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${nanoid(8)}`;
  await fsp.copyFile(sourcePath, tmp);
  await fsp.rename(tmp, target);
  getDb()
    .insert(shareBlobs)
    .values({ sha256, sizeBytes, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

export function blobPath(sha256: string): string {
  return blobPathFor(sha256);
}

async function hashFile(p: string): Promise<string> {
  const buf = await fsp.readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 物化当前 files/<shareId>/ 全量 manifest + 所有 blob，并插入 share_versions 行。
 * 返回新版本的 versionNo。事务内完成：manifest 与 DB 行要么都成功要么都失败。
 * 调用方在「即将改动文件前」调用——版本快照记录的是改前的状态。
 */
export async function snapshotVersion(
  share: Share,
  label?: string,
): Promise<number> {
  const db = getDb();
  const files = db
    .select()
    .from(shareFiles)
    .where(eq(shareFiles.shareId, share.id))
    .all();

  // 收集所有文件并写 blob
  const manifest: ManifestEntry[] = [];
  for (const f of files) {
    const p = filePathFor(share.id, f.path);
    const sha = await hashFile(p);
    await writeBlobIfAbsent(sha, p, f.sizeBytes);
    manifest.push({
      path: f.path,
      sha256: sha,
      sizeBytes: f.sizeBytes,
      mimeType: f.mimeType,
    });
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));

  const versionNo = db.transaction((tx) => {
    const maxRow = tx
      .select({ m: sql<number>`max(${shareVersions.versionNo})` })
      .from(shareVersions)
      .where(eq(shareVersions.shareId, share.id))
      .get();
    const next = (maxRow?.m ?? 0) + 1;
    tx.insert(shareVersions)
      .values({
        id: nanoid(16),
        shareId: share.id,
        versionNo: next,
        label: label ?? null,
        manifest: JSON.stringify(manifest),
        createdAt: Date.now(),
      })
      .run();
    return next;
  });

  await pruneVersions(share.id);
  publishShareEvent(share.id, "version", { versionNo });
  return versionNo;
}

/** 创建时立即记 v1（由 createShare 调用，manifest 里就是刚上传的文件） */
export async function snapshotInitialVersion(share: Share): Promise<void> {
  await snapshotVersion(share, "initial");
}

export interface ShareVersionInfo {
  id: string;
  versionNo: number;
  label: string | null;
  fileCount: number;
  createdAt: number;
}

export function listVersions(shareId: string): ShareVersionInfo[] {
  const rows = getDb()
    .select()
    .from(shareVersions)
    .where(eq(shareVersions.shareId, shareId))
    .orderBy(desc(shareVersions.versionNo))
    .all();
  return rows.map((r) => ({
    id: r.id,
    versionNo: r.versionNo,
    label: r.label,
    fileCount: (JSON.parse(r.manifest) as ManifestEntry[]).length,
    createdAt: r.createdAt,
  }));
}

export function getVersionManifest(
  shareId: string,
  versionNo: number,
): ManifestEntry[] | null {
  const row = getDb()
    .select()
    .from(shareVersions)
    .where(
      and(
        eq(shareVersions.shareId, shareId),
        eq(shareVersions.versionNo, versionNo),
      ),
    )
    .get();
  if (!row) return null;
  return JSON.parse(row.manifest) as ManifestEntry[];
}

/**
 * 回滚：把版本 n 的 manifest 物化回 files/<shareId>/（旧文件删、blob 复制回来），
 * 然后对回滚后的新状态再产出一个版本（"回滚本身"也是一个版本，历史只增不减）。
 */
export async function rollbackToVersion(
  share: Share,
  targetVersionNo: number,
): Promise<{ versionNo: number } | { error: string }> {
  const manifest = getVersionManifest(share.id, targetVersionNo);
  if (!manifest) return { error: "版本不存在" };

  // 1. 把目标 manifest 的文件写回 files/<shareId>/
  const manifestPaths = new Set(manifest.map((m) => m.path));
  const currentFiles = getDb()
    .select()
    .from(shareFiles)
    .where(eq(shareFiles.shareId, share.id))
    .all();

  // 删除不在目标 manifest 里的当前文件
  for (const cf of currentFiles) {
    if (!manifestPaths.has(cf.path)) {
      await deleteFile(share.id, cf.path);
    }
  }
  // 目标 manifest 里的文件：从 blob 写回（存在且 sha 一致则跳过）
  for (const m of manifest) {
    if (!isValidSharePath(m.path)) return { error: `非法路径：${m.path}` };
    const current = currentFiles.find((f) => f.path === m.path);
    let needWrite = !current;
    if (current) {
      const curSha = await hashFile(filePathFor(share.id, m.path));
      needWrite = curSha !== m.sha256;
    }
    if (needWrite) {
      const blob = blobPathFor(m.sha256);
      const buf = await fsp.readFile(blob);
      await saveFile(share.id, m.path, buf);
    }
  }

  // 2. 重写 share_files 清单 + shares 元数据
  const db = getDb();
  const now = Date.now();
  db.transaction((tx) => {
    tx.delete(shareFiles).where(eq(shareFiles.shareId, share.id)).run();
    for (const m of manifest) {
      tx.insert(shareFiles)
        .values({
          shareId: share.id,
          path: m.path,
          mimeType: m.mimeType,
          sizeBytes: m.sizeBytes,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    // 恢复 entryPath 指向的文件元数据；若入口在 manifest 里则以它为准，否则取第一个 html
    const entry =
      manifest.find((m) => m.path === share.entryPath) ??
      manifest.find((m) => classifyFile(m.path).kind === "html") ??
      manifest[0];
    if (entry) {
      const { kind } = classifyFile(entry.path);
      const react = share.runtime === "react";
      tx.update(shares)
        .set({
          updatedAt: now,
          entryPath: entry.path,
          kind: react ? "html" : kind,
          mimeType: react ? "text/html" : entry.mimeType,
          size: entry.sizeBytes,
        })
        .where(eq(shares.id, share.id))
        .run();
    }
  });

  // 3. 对回滚后的状态产出一个新版本（历史只增不减）
  const refreshed = getDb()
    .select()
    .from(shares)
    .where(eq(shares.id, share.id))
    .get()!;
  const newVersionNo = await snapshotVersion(
    refreshed,
    `rollback to v${targetVersionNo}`,
  );
  return { versionNo: newVersionNo };
}

/** 每 share 最多保留 MAX_VERSIONS_PER_SHARE 个版本；超出清最老的并回收孤儿 blob */
export async function pruneVersions(shareId: string): Promise<void> {
  const db = getDb();
  const rows = db
    .select({ versionNo: shareVersions.versionNo })
    .from(shareVersions)
    .where(eq(shareVersions.shareId, shareId))
    .orderBy(desc(shareVersions.versionNo))
    .all();
  if (rows.length <= MAX_VERSIONS_PER_SHARE) return;
  const toDelete = rows.slice(MAX_VERSIONS_PER_SHARE).map((r) => r.versionNo);
  for (const v of toDelete) {
    db.delete(shareVersions)
      .where(
        and(
          eq(shareVersions.shareId, shareId),
          eq(shareVersions.versionNo, v),
        ),
      )
      .run();
  }
  await pruneOrphanBlobs();
}

/** 全库扫描：任何 manifest 都不再引用的 blob 删除（含磁盘文件） */
async function pruneOrphanBlobs(): Promise<void> {
  const db = getDb();
  const referenced = new Set<string>();
  const allVersions = db.select({ m: shareVersions.manifest }).from(shareVersions).all();
  for (const r of allVersions) {
    for (const entry of JSON.parse(r.m) as ManifestEntry[]) {
      referenced.add(entry.sha256);
    }
  }
  const allBlobs = db.select().from(shareBlobs).all();
  for (const b of allBlobs) {
    if (!referenced.has(b.sha256)) {
      db.delete(shareBlobs).where(eq(shareBlobs.sha256, b.sha256)).run();
      try {
        await fsp.unlink(blobPathFor(b.sha256));
      } catch {}
    }
  }
}
