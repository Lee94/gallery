import { z } from "zod";
import type { User } from "@/db/schema";
import { TOOLS } from "./tools";

// 手写的最小 MCP（Streamable HTTP / JSON-RPC 2.0）无状态服务器。
// 只实现 tools 能力所需的方法；不签发 Mcp-Session-Id（无状态），每个 POST 独立处理。
// 参考 MCP 规范 2025-06-18：initialize / notifications/initialized / tools/list / tools/call / ping。

const SERVER_INFO = { name: "gallery", version: "0.1.0" };
// 客户端请求的协议版本我们直接回显（tools 这套表面在各版本间稳定），无请求时回落到当前稳定版。
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const INSTRUCTIONS =
  "Gallery 文件分享服务。用 upload_file 上传文件（HTML/PDF/图片/Markdown/文本等）并获得可分享的 " +
  "/s/<slug> 链接，可选设置访问密码与有效期；用 list_shares / delete_share / set_password / " +
  "remove_password / set_expiry 管理已上传的分享。所有操作仅作用于当前令牌所属用户自己的文件。";

export const JSONRPC = {
  // 标准码
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // 传输层自定义码（-32000~-32099 为实现保留区），各语义独立以便客户端按 code 分支
  UNAUTHORIZED: -32001,
  RATE_LIMITED: -32002,
  PAYLOAD_TOO_LARGE: -32003,
} as const;

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}
export function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/**
 * 处理单条 JSON-RPC 消息，返回响应对象；若是通知（无需回复）则返回 null（调用方回 202）。
 */
export async function handleMcpMessage(
  user: User,
  msg: unknown,
): Promise<object | null> {
  if (
    !msg ||
    typeof msg !== "object" ||
    Array.isArray(msg) ||
    (msg as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    typeof (msg as { method?: unknown }).method !== "string"
  ) {
    return jsonRpcError(null, JSONRPC.INVALID_REQUEST, "Invalid JSON-RPC request");
  }

  const { id, method, params } = msg as {
    id?: JsonRpcId;
    method: string;
    params?: unknown;
  };
  // 通知（含 notifications/initialized、notifications/cancelled 等）一律不回复
  if (method.startsWith("notifications/")) return null;
  const replyId: JsonRpcId = id ?? null;

  switch (method) {
    case "initialize": {
      const requested = (params as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
      return ok(replyId, {
        protocolVersion:
          typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "ping":
      return ok(replyId, {});

    case "tools/list":
      return ok(replyId, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.jsonSchema,
        })),
      });

    case "tools/call": {
      const p = params as { name?: string; arguments?: unknown } | undefined;
      const tool = TOOLS.find((t) => t.name === p?.name);
      if (!tool) {
        return jsonRpcError(replyId, JSONRPC.INVALID_PARAMS, `Unknown tool: ${p?.name}`);
      }
      const parsed = tool.inputSchema.safeParse(p?.arguments ?? {});
      if (!parsed.success) {
        // 参数错误作为「工具级错误」回传，agent 可据此纠正后重试
        return ok(replyId, {
          content: [{ type: "text", text: `参数无效：${z.prettifyError(parsed.error)}` }],
          isError: true,
        });
      }
      try {
        return ok(replyId, await tool.handler(user, parsed.data));
      } catch (e) {
        return ok(replyId, {
          content: [
            { type: "text", text: `执行失败：${e instanceof Error ? e.message : "未知错误"}` },
          ],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcError(replyId, JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
