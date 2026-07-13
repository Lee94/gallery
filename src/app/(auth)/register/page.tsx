import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { RegisterForm } from "@/components/register-form";

export const metadata: Metadata = { title: "注册" };

// 请求时查库判断是否首个用户，不能预渲染
export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const count = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(users)
    .get()!.c;
  return <RegisterForm needsInvite={count > 0} defaultInviteCode={code} />;
}
