import { NextResponse, type NextRequest } from "next/server";
import { validateApiToken } from "@/lib/auth/api-token";
import { getEnv } from "@/lib/env";
import { handleMcpMessage, jsonRpcError, JSONRPC } from "@/lib/mcp/server";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

// MCP Streamable HTTP 端点：认证走 Authorization: Bearer <token>（api_tokens 表），
// 因此不套用 /api/upload 的 Origin 校验（Bearer 天然免疫 CSRF）。无状态：每个 POST 独立处理。

function rpc(code: number, message: string, status: number) {
  return NextResponse.json(jsonRpcError(null, code, message), { status });
}

/**
 * 读取请求体但按 maxBytes 硬截断——不信任 Content-Length（可用 chunked 传输绕过），
 * 边读边累加字节数，超限立即中止，避免把超大 body 全量读进内存造成 DoS。
 */
async function readBodyCapped(
  request: NextRequest,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: true }> {
  const body = request.body;
  if (!body) return { text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

export async function POST(request: NextRequest) {
  // 认证前按 IP 粗限流（与 login/register 一致），防无效令牌请求无限消耗哈希+查库
  const ip = await getClientIp();
  if (!rateLimit(`mcp-ip:${ip}`, 600, 60_000)) {
    return rpc(JSONRPC.RATE_LIMITED, "Too Many Requests", 429);
  }

  const user = validateApiToken(request.headers.get("authorization"));
  if (!user) {
    return NextResponse.json(jsonRpcError(null, JSONRPC.UNAUTHORIZED, "Unauthorized"), {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="gallery-mcp"' },
    });
  }

  // 认证后按令牌所属用户精确限流（进程内固定窗口）
  if (!rateLimit(`mcp:${user.id}`, 120, 60_000)) {
    return rpc(JSONRPC.RATE_LIMITED, "Too Many Requests", 429);
  }

  // body 上限：base64 约 1.37x 膨胀 + JSON 包裹，给 2x + 1MB 余量；按字节数硬截断
  const maxBody = getEnv().maxFileSizeBytes * 2 + 1024 * 1024;
  const read = await readBodyCapped(request, maxBody);
  if ("tooLarge" in read) {
    return rpc(JSONRPC.PAYLOAD_TOO_LARGE, "Payload too large", 413);
  }

  let message: unknown;
  try {
    message = JSON.parse(read.text);
  } catch {
    return rpc(JSONRPC.PARSE_ERROR, "Parse error", 400);
  }

  const response = await handleMcpMessage(user, message);
  // 通知类消息无需回复：返回 202 Accepted、空 body
  if (response === null) return new NextResponse(null, { status: 202 });
  return NextResponse.json(response);
}

// 本服务器不提供服务端主动推送（SSE），GET/DELETE 一律 405
export function GET() {
  return new NextResponse("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
