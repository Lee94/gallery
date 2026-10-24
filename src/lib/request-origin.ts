import { getEnv } from "@/lib/env";

// route handler 没有 Server Action 的内建 Origin 校验，手动做（防 CSRF）
export function isValidOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (origin === getEnv().appUrl) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}
