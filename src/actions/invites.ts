"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { customAlphabet, nanoid } from "nanoid";
import { getDb } from "@/db";
import { inviteCodes } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/current-user";

// 全小写 + 无易混字符，方便口头/手动传达
const generateInviteCode = customAlphabet(
  "23456789abcdefghijkmnpqrstuvwxyz",
  12,
);

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") throw new Error("无权操作");
  return user;
}

export async function createInvite(): Promise<void> {
  const user = await requireAdmin();
  getDb()
    .insert(inviteCodes)
    .values({
      id: nanoid(16),
      code: generateInviteCode(),
      createdBy: user.id,
      createdAt: Date.now(),
    })
    .run();
  revalidatePath("/admin/invites");
}

/** 只能撤销未使用的码（已用的保留作注册记录） */
export async function revokeInvite(inviteId: string): Promise<void> {
  await requireAdmin();
  getDb()
    .delete(inviteCodes)
    .where(and(eq(inviteCodes.id, inviteId), isNull(inviteCodes.usedBy)))
    .run();
  revalidatePath("/admin/invites");
}
