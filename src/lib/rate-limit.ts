import { headers } from "next/headers";
import { getEnv } from "@/lib/env";

// 进程内固定窗口限流：单实例 VPS 部署足够，重启即清零（可接受）
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** 返回 true 表示放行，false 表示已超限 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/**
 * 仅在 TRUST_PROXY=1 时信任 x-forwarded-for（取第一项）。
 * 直连部署拿不到远端地址时退化为全局共享的 "direct" 桶——限流变粗但仍然有效。
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  if (getEnv().trustProxy) {
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    const realIp = h.get("x-real-ip");
    if (realIp) return realIp;
  }
  return "direct";
}
