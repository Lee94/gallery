import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { createInvite, revokeInvite } from "@/actions/invites";
import { getDb } from "@/db";
import { inviteCodes, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/current-user";
import { CopyButton } from "@/components/copy-button";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui";

export const metadata: Metadata = { title: "邀请码" };

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default async function InvitesPage() {
  // layout 已校验登录，这里二次校验角色
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/dashboard");

  const rows = getDb()
    .select({ invite: inviteCodes, usedByEmail: users.email })
    .from(inviteCodes)
    .leftJoin(users, eq(inviteCodes.usedBy, users.id))
    .orderBy(desc(inviteCodes.createdAt))
    .all();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          邀请码
          <span className="ml-2 text-sm font-normal text-zinc-500">
            新用户注册需要邀请码，一码一用
          </span>
        </h1>
        <form action={createInvite}>
          <button type="submit" className={primaryButtonClass}>
            生成邀请码
          </button>
        </form>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">还没有邀请码</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ invite, usedByEmail }) => (
            <li
              key={invite.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
            >
              <code className="font-mono text-sm font-medium">
                {invite.code}
              </code>
              <span className="text-xs text-zinc-500" suppressHydrationWarning>
                {formatDate(invite.createdAt)} 创建
              </span>
              <span className="flex-1" />
              {invite.usedBy ? (
                <span
                  className="text-xs text-zinc-500"
                  suppressHydrationWarning
                >
                  已被 {usedByEmail ?? "（已注销用户）"} 使用
                  {invite.usedAt ? ` · ${formatDate(invite.usedAt)}` : ""}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <CopyButton path={`/register?code=${invite.code}`} />
                  <form action={revokeInvite.bind(null, invite.id)}>
                    <button type="submit" className={secondaryButtonClass}>
                      撤销
                    </button>
                  </form>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
