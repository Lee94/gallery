import { z } from "zod";
import type { Share, User } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { fileTooLargeMessage, getEnv } from "@/lib/env";
import { createShare } from "@/lib/shares/create";
import {
  deleteShareFor,
  findOwnedShareBySlug,
  listSharesFor,
  removeSharePasswordFor,
  setShareExpiryFor,
  setSharePasswordFor,
} from "@/lib/shares/manage";

// MCP tools/call 的结果结构（content 数组 + 可选 isError / structuredContent）。
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodType; // 运行时校验 tools/call 参数
  jsonSchema: Record<string, unknown>; // tools/list 暴露给客户端的 JSON Schema
  handler: (user: User, args: unknown) => Promise<ToolResult> | ToolResult;
}

function ok(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// 「按 slug 找到本人所有的分享 → 失败即返回 isError → 执行操作」的公共骨架，
// 收敛 delete/set_password/remove_password/set_expiry 四个工具开头的样板。
function withOwnedShare(
  userId: string,
  slug: string,
  fn: (share: Share) => Promise<ToolResult> | ToolResult,
): Promise<ToolResult> | ToolResult {
  const found = findOwnedShareBySlug(userId, slug);
  return "error" in found ? fail(found.error) : fn(found.share);
}

// "30m" / "12h" / "7d" / "2w" → 毫秒；非法返回 null
const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};
function parseDuration(input: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(input.trim());
  if (!m) return null;
  const ms = Number(m[1]) * DURATION_UNITS[m[2]!]!;
  return ms > 0 ? ms : null;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // io:"input"——按「调用方要传什么」生成：带默认值的字段（如 encoding）视为可选，不进 required
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema; // 部分 MCP 客户端不接受该顶层键
  return json;
}

// 定义一个工具：保留 handler 参数的静态类型，同时预生成 tools/list 用的 JSON Schema。
function defineTool<S extends z.ZodType>(t: {
  name: string;
  description: string;
  inputSchema: S;
  handler: (user: User, args: z.infer<S>) => Promise<ToolResult> | ToolResult;
}): McpTool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    jsonSchema: toJsonSchema(t.inputSchema),
    handler: t.handler as unknown as McpTool["handler"],
  };
}

const slugArg = z.string().min(1).describe("分享的 slug（分享链接 /s/<slug> 里的那段）");

export const TOOLS: McpTool[] = [
  defineTool({
    name: "upload_file",
    description:
      "上传一个文件到 Gallery 并返回可分享的 /s/<slug> 链接。支持 HTML/PDF/图片/Markdown/文本等；" +
      "文件类型由 filename 的扩展名决定。可选设置访问密码与有效期。",
    inputSchema: z.object({
      filename: z
        .string()
        .min(1)
        .max(255)
        .describe("文件名（含扩展名），扩展名决定类型与渲染方式，如 report.html、diagram.png"),
      content: z
        .string()
        .describe("文件内容。文本文件直接给字符串；二进制文件（图片/PDF）给 base64 且 encoding=base64"),
      encoding: z
        .enum(["utf8", "base64"])
        .default("utf8")
        .describe("content 的编码。二进制文件用 base64，文本文件用 utf8"),
      password: z.string().max(200).optional().describe("可选：设置访问密码，访客需输入才能查看"),
      expiresIn: z
        .string()
        .optional()
        .describe("可选：有效期，形如 30m / 12h / 7d / 2w，到期后链接自动失效"),
    }),
    handler: async (user, args) => {
      const env = getEnv();
      const buf = Buffer.from(args.content, args.encoding === "base64" ? "base64" : "utf8");
      if (buf.length === 0) return fail("文件内容为空");
      if (buf.length > env.maxFileSizeBytes) return fail(fileTooLargeMessage());

      let expiresAt: number | null = null;
      if (args.expiresIn) {
        const ms = parseDuration(args.expiresIn);
        if (ms === null) return fail(`无法解析 expiresIn：「${args.expiresIn}」（示例：30m、12h、7d、2w）`);
        expiresAt = Date.now() + ms;
      }
      const passwordHash = args.password ? await hashPassword(args.password) : null;

      const { slug, url, share } = await createShare({
        ownerId: user.id,
        filename: args.filename,
        content: buf,
        size: buf.length,
        passwordHash,
        expiresAt,
      });

      const notes = [
        passwordHash ? "已设置访问密码" : null,
        expiresAt ? `有效期至 ${new Date(expiresAt).toISOString()}` : null,
      ].filter(Boolean);
      const text =
        `已上传「${share.originalName}」\n分享链接：${url}` +
        (notes.length ? `\n（${notes.join("；")}）` : "");
      return ok(text, {
        slug,
        url,
        kind: share.kind,
        size: share.size,
        hasPassword: passwordHash !== null,
        expiresAt,
      });
    },
  }),

  defineTool({
    name: "list_shares",
    description: "列出当前令牌所属用户已上传的所有分享（含链接、类型、大小、是否有密码、过期时间）。",
    inputSchema: z.object({}),
    handler: (user) => {
      const env = getEnv();
      const items = listSharesFor(user.id).map((s) => ({
        slug: s.slug,
        url: `${env.appUrl}/s/${s.slug}`,
        filename: s.originalName,
        kind: s.kind,
        size: s.size,
        hasPassword: s.passwordHash !== null,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      }));
      const text = items.length
        ? items
            .map(
              (i) =>
                `• ${i.filename} — ${i.url}` +
                (i.hasPassword ? " 🔒" : "") +
                (i.expiresAt ? ` (过期于 ${new Date(i.expiresAt).toISOString()})` : ""),
            )
            .join("\n")
        : "还没有任何分享。";
      return ok(text, { count: items.length, shares: items });
    },
  }),

  defineTool({
    name: "delete_share",
    description: "删除一个分享，其 /s/<slug> 链接立即失效。只能删除自己的分享。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        await deleteShareFor(user.id, share.id);
        return ok(`已删除「${share.originalName}」，链接已失效。`, {
          slug: args.slug,
          deleted: true,
        });
      }),
  }),

  defineTool({
    name: "set_password",
    description: "给一个分享设置或修改访问密码。设置后所有已发出的免密访问令牌立即失效。",
    inputSchema: z.object({
      slug: slugArg,
      password: z.string().min(1).max(200).describe("新的访问密码"),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        const res = await setSharePasswordFor(user.id, share.id, args.password);
        if (res.error) return fail(res.error);
        return ok(`已为「${share.originalName}」设置访问密码。`, {
          slug: args.slug,
          hasPassword: true,
        });
      }),
  }),

  defineTool({
    name: "remove_password",
    description: "移除一个分享的访问密码，使其变为公开可访问。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = removeSharePasswordFor(user.id, share.id);
        if (res.error) return fail(res.error);
        return ok(`已移除「${share.originalName}」的访问密码，现在公开可访问。`, {
          slug: args.slug,
          hasPassword: false,
        });
      }),
  }),

  defineTool({
    name: "set_expiry",
    description: "设置或清除一个分享的有效期。expiresIn 传时长（如 7d）设置过期；传 never 则永不过期。",
    inputSchema: z.object({
      slug: slugArg,
      expiresIn: z
        .string()
        .describe("有效期时长，形如 30m / 12h / 7d / 2w；传 never 表示永不过期"),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        let expiresAt: number | null = null;
        const raw = args.expiresIn.trim();
        if (raw && raw.toLowerCase() !== "never") {
          const ms = parseDuration(raw);
          if (ms === null) return fail(`无法解析 expiresIn：「${args.expiresIn}」（示例：30m、12h、7d、2w、never）`);
          expiresAt = Date.now() + ms;
        }
        const res = setShareExpiryFor(user.id, share.id, expiresAt);
        if (res.error) return fail(res.error);
        return ok(
          expiresAt
            ? `已设置「${share.originalName}」的有效期至 ${new Date(expiresAt).toISOString()}。`
            : `已移除「${share.originalName}」的有效期，现在永不过期。`,
          { slug: args.slug, expiresAt },
        );
      }),
  }),
];
