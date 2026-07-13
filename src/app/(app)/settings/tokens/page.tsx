import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiTokens } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getEnv } from "@/lib/env";
import { ApiTokenManager, type TokenRow } from "@/components/api-token-manager";

export const metadata: Metadata = { title: "API 令牌" };

export default async function TokensPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const tokens: TokenRow[] = getDb()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id))
    .orderBy(desc(apiTokens.createdAt))
    .all();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">API 令牌</h1>
        <p className="mt-1 text-sm text-zinc-500">
          用于让 AI agent 通过 MCP 上传与管理文件。令牌以你的身份操作，只能访问你自己的分享。
        </p>
      </div>
      <ApiTokenManager
        tokens={tokens}
        mcpUrl={`${getEnv().appUrl}/api/mcp`}
      />
    </div>
  );
}
