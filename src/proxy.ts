import { NextResponse, type NextRequest } from "next/server";

// 与 src/lib/auth/session.ts 的 SESSION_COOKIE 保持一致。
// 不直接 import 是为了避免把 better-sqlite3 等依赖拖进 proxy bundle。
const SESSION_COOKIE = "session";

// 只做粗筛（有无 session cookie），真正的鉴权在 (app)/layout 与各 action 内完成
export function proxy(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/settings/:path*"],
};
