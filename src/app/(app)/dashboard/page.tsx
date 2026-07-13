import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { shares, type Share } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getEnv } from "@/lib/env";
import { ShareList, type ShareRow } from "@/components/share-list";
import { UploadDropzone } from "@/components/upload-dropzone";

export const metadata: Metadata = { title: "我的文件" };

// 按请求时刻快照序列化给客户端组件（组件 render 内不允许调 Date.now）
function toShareRows(rows: Share[]): ShareRow[] {
  const now = Date.now();
  return rows.map((s) => ({
    id: s.id,
    slug: s.slug,
    originalName: s.originalName,
    size: s.size,
    kind: s.kind,
    hasPassword: s.passwordHash !== null, // 只传布尔值，hash 不进客户端
    expiresAt: s.expiresAt,
    expired: s.expiresAt !== null && s.expiresAt <= now,
    createdAt: s.createdAt,
  }));
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const list = toShareRows(
    getDb()
      .select()
      .from(shares)
      .where(eq(shares.ownerId, user.id))
      .orderBy(desc(shares.createdAt))
      .all(),
  );

  return (
    <div className="flex flex-col gap-8">
      <UploadDropzone
        maxFileSizeMb={getEnv().maxFileSizeBytes / 1024 / 1024}
      />
      <section>
        <h1 className="mb-4 text-lg font-semibold">
          我的文件
          <span className="ml-2 text-sm font-normal text-zinc-500">
            {list.length} 个
          </span>
        </h1>
        {list.length === 0 ? (
          <p className="text-sm text-zinc-500">还没有文件，上传一个试试</p>
        ) : (
          <ShareList shares={list} />
        )}
      </section>
    </div>
  );
}
