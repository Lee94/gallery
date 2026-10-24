import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { sharePageStates, shareVisitorStates } from "@/db/schema";
import { ArtifactManager, type ManagedFile } from "@/components/artifact-manager";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getEnv } from "@/lib/env";
import { listComments } from "@/lib/shares/comments";
import { getKvPolicy, isValidCollection, kvList } from "@/lib/shares/kv";
import { getLlmUsageToday } from "@/lib/shares/llm";
import {
  findOwnedShareBySlug,
  listShareFiles,
  MAX_SHARE_EDITOR_FILE_BYTES,
} from "@/lib/shares/manage";
import { listVersions } from "@/lib/shares/versions";
import { readFileText } from "@/lib/storage";

export const metadata: Metadata = { title: "管理 Artifact" };

const MAX_EDITOR_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_KV_VALUE_PREVIEW_CHARS = 4000;

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ collection?: string }>;
};

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default async function ArtifactManagementPage({ params, searchParams }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const found = findOwnedShareBySlug(user.id, slug);
  if ("error" in found) notFound();
  const { share } = found;
  const db = getDb();

  const fileRows = listShareFiles(share.id);
  let editorBudget = MAX_EDITOR_TOTAL_BYTES;
  const files: ManagedFile[] = [];
  for (const file of fileRows) {
    let textContent: string | null = null;
    const canRead =
      file.mimeType.startsWith("text/") &&
      file.sizeBytes <= MAX_SHARE_EDITOR_FILE_BYTES &&
      file.sizeBytes <= editorBudget;
    if (canRead) {
      try {
        textContent = await readFileText(share.id, file.path);
        editorBudget -= file.sizeBytes;
      } catch {
        // 文件在磁盘上缺失或暂时不可读时仍保留清单与下载入口。
      }
    }
    files.push({
      path: file.path,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      isEntry: file.path === share.entryPath,
      textContent,
    });
  }

  const pageState = db
    .select()
    .from(sharePageStates)
    .where(eq(sharePageStates.shareId, share.id))
    .get();
  const visitorStateCount = db
    .select({ count: sql<number>`count(*)` })
    .from(shareVisitorStates)
    .where(eq(shareVisitorStates.shareId, share.id))
    .get()?.count ?? 0;

  const requestedCollection = query.collection ?? "default";
  const collection = isValidCollection(requestedCollection) ? requestedCollection : "default";
  const kvResult = share.kvEnabled
    ? kvList(share.id, collection, { limit: 50 })
    : { items: [], nextCursor: null };

  return (
    <ArtifactManager
      key={`${share.id}:${share.updatedAt}:${collection}:${share.dataGeneration}:${share.dataSchemaVersion}`}
      share={{
        id: share.id,
        slug: share.slug,
        originalName: share.originalName,
        title: share.title,
        description: share.description,
        icon: share.icon,
        coverPath: share.coverPath,
        sourceEnabled: share.sourceEnabled,
        forkedFromSlug: share.forkedFromSlug,
        kind: share.kind,
        runtime: share.runtime,
        runtimeVersion: share.runtimeVersion,
        size: share.size,
        entryPath: share.entryPath,
        createdAt: share.createdAt,
        updatedAt: share.updatedAt,
        hasPassword: share.passwordHash !== null,
        expiresAt: share.expiresAt,
        pageStateEnabled: share.pageStateEnabled,
        visitorStateEnabled: share.visitorStateEnabled,
        kvEnabled: share.kvEnabled,
        attachmentsEnabled: share.attachmentsEnabled,
        commentsEnabled: share.commentsEnabled,
        commentsVisitorWrite: share.commentsVisitorWrite,
        dataGeneration: share.dataGeneration,
        dataSchemaVersion: share.dataSchemaVersion,
        llmEnabled: share.llmEnabled,
        llmDailyTokenBudget: share.llmDailyTokenBudget,
        llmModel: share.llmModel,
        llmConfigured: Boolean(getEnv().llm),
      }}
      files={files}
      versions={listVersions(share.id).map((version) => ({
        versionNo: version.versionNo,
        label: version.label,
        fileCount: version.fileCount,
        createdAt: version.createdAt,
      }))}
      pageState={
        share.pageStateEnabled && pageState
          ? {
              prettyJson: prettyJson(pageState.dataJson),
              version: pageState.version,
              sizeBytes: pageState.sizeBytes,
              updatedAt: pageState.updatedAt,
            }
          : null
      }
      visitorStateCount={visitorStateCount}
      kvCollection={collection}
      kvPolicy={getKvPolicy(share.id, collection)}
      kvItems={kvResult.items.map((item) => {
        const serialized = JSON.stringify(item.value) ?? "null";
        return {
          key: item.key,
          valueText:
            serialized.length > MAX_KV_VALUE_PREVIEW_CHARS
              ? `${serialized.slice(0, MAX_KV_VALUE_PREVIEW_CHARS)}…`
              : serialized,
          version: item.version,
          sizeBytes: item.sizeBytes,
          updatedAt: item.updatedAt,
        };
      })}
      kvHasMore={kvResult.nextCursor !== null}
      comments={listComments(share.id, { includeHidden: true }).map((comment) => ({
        id: comment.id,
        authorLabel: comment.authorLabel,
        body: comment.body,
        isOwner: comment.isOwner,
        status: comment.status,
        createdAt: comment.createdAt,
      }))}
      llmUsage={getLlmUsageToday(share)}
    />
  );
}
