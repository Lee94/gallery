import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { shareFiles, shares, type Share, type User } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { fileTooLargeMessage, getEnv } from "@/lib/env";
import { classifyFile } from "@/lib/file-kind";
import { createShare } from "@/lib/shares/create";
import {
  clearShareKvCollectionFor,
  deleteShareFileFor,
  deleteShareFor,
  findOwnedShareBySlug,
  forkShareFor,
  listShareFiles,
  listSharesFor,
  moveShareFor,
  publishShareVersionFor,
  removeSharePasswordFor,
  resetShareDataSpaceFor,
  resetSharePageStateFor,
  resetShareVisitorStateFor,
  rollbackShareVersionFor,
  setShareCommentsEnabledFor,
  setShareAttachmentsEnabledFor,
  setShareCommentsVisitorWriteFor,
  setShareCommentStatusFor,
  setShareDataSchemaVersionFor,
  setShareExpiryFor,
  setShareKvEnabledFor,
  setShareKvPolicyFor,
  setShareLlmEnabledFor,
  setShareMetadataFor,
  setSharePageStateEnabledFor,
  setSharePasswordFor,
  setSharePinnedFor,
  setShareVisitorStateEnabledFor,
  upsertShareFileFor,
} from "@/lib/shares/manage";
import {
  addComment,
  banVisitor,
  listComments,
  unbanVisitor,
} from "@/lib/shares/comments";
import {
  getKvPolicy,
  isValidCollection,
  isValidKvKey,
  kvCountRows,
  kvDelete,
  kvGet,
  kvList,
  kvPut,
} from "@/lib/shares/kv";
import { getLlmUsageToday } from "@/lib/shares/llm";
import { listVersions, snapshotVersion } from "@/lib/shares/versions";
import { isValidSharePath, saveFile } from "@/lib/storage";

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
// 收敛各管理工具开头的所有权校验样板。
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
      "文件类型由 filename 的扩展名决定。可选设置访问密码与有效期；HTML 可通过 pageStateEnabled 启用访客共享可写的 JSON 页面数据。",
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
      runtime: z.enum(["static", "react"]).default("static").describe("JSX/TSX 入口选择 react；使用服务器锁定的 React 版本"),
      password: z.string().max(200).optional().describe("可选：设置访问密码，访客需输入才能查看"),
      expiresIn: z
        .string()
        .optional()
        .describe("可选：有效期，形如 30m / 12h / 7d / 2w，到期后链接自动失效"),
      pageStateEnabled: z
        .boolean()
        .default(false)
        .describe("仅 HTML：是否启用共享页面数据。所有能访问分享的访客都可读写；页面需引入 /sdk/page-state-v1.js"),
      visitorStateEnabled: z
        .boolean()
        .default(false)
        .describe("仅 HTML：是否启用访客私有数据。每个访客有独立可写 JSON；页面需引入 /sdk/page-state-v1.js 并使用 GalleryVisitorState"),
      kvEnabled: z
        .boolean()
        .default(false)
        .describe("仅 HTML：是否启用行级共享数据（collection/key 行集，访客可并行读写）；页面使用 GalleryDB"),
      commentsEnabled: z
        .boolean()
        .default(false)
        .describe("是否在分享页开启评论面板（任何 kind 可用；访客可发评论，owner 可管理）"),
      attachmentsEnabled: z.boolean().default(false).describe("是否允许页面上传私有或共享附件"),
      llmEnabled: z
        .boolean()
        .default(false)
        .describe("仅 HTML：是否允许页面调用服务端配置的 LLM（需 LLM_BASE_URL/LLM_API_KEY 环境变量）；页面使用 GalleryLLM"),
      llmDailyTokenBudget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("可选：LLM 每日 token 配额（默认 50000）"),
      llmModel: z
        .string()
        .max(100)
        .optional()
        .describe("可选：覆盖服务端默认模型"),
    }),
    handler: async (user, args) => {
      const env = getEnv();
      const buf = Buffer.from(args.content, args.encoding === "base64" ? "base64" : "utf8");
      if (buf.length === 0) return fail("文件内容为空");
      if (buf.length > env.maxFileSizeBytes) return fail(fileTooLargeMessage());
      if (
        (args.pageStateEnabled || args.visitorStateEnabled || args.kvEnabled || args.llmEnabled || args.attachmentsEnabled) &&
        classifyFile(args.filename).kind !== "html" && args.runtime !== "react"
      ) {
        return fail("只有 HTML 文件可以启用页面数据/行集/LLM");
      }

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
        runtime: args.runtime,
        passwordHash,
        expiresAt,
        pageStateEnabled: args.pageStateEnabled,
        visitorStateEnabled: args.visitorStateEnabled,
        kvEnabled: args.kvEnabled,
        commentsEnabled: args.commentsEnabled,
        attachmentsEnabled: args.attachmentsEnabled,
        llmEnabled: args.llmEnabled,
        llmDailyTokenBudget: args.llmDailyTokenBudget,
        llmModel: args.llmModel,
      });

      const notes = [
        passwordHash ? "已设置访问密码" : null,
        expiresAt ? `有效期至 ${new Date(expiresAt).toISOString()}` : null,
        share.pageStateEnabled ? "已启用共享页面数据" : null,
        share.visitorStateEnabled ? "已启用访客数据" : null,
        share.kvEnabled ? "已启用行集" : null,
        share.runtime === "react" ? `React ${share.runtimeVersion}` : null,
        share.commentsEnabled ? "已启用评论" : null,
        share.llmEnabled ? "已启用 LLM" : null,
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
        pageStateEnabled: share.pageStateEnabled,
        visitorStateEnabled: share.visitorStateEnabled,
        kvEnabled: share.kvEnabled,
        commentsEnabled: share.commentsEnabled,
        llmEnabled: share.llmEnabled,
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
        pageStateEnabled: s.pageStateEnabled,
        visitorStateEnabled: s.visitorStateEnabled,
        kvEnabled: s.kvEnabled,
        commentsEnabled: s.commentsEnabled,
        llmEnabled: s.llmEnabled,
      }));
      const text = items.length
        ? items
            .map(
              (i) =>
                `• ${i.filename} — ${i.url}` +
                (i.pageStateEnabled ? " [共享数据]" : "") +
                (i.visitorStateEnabled ? " [访客数据]" : "") +
                (i.kvEnabled ? " [行集]" : "") +
                (i.commentsEnabled ? " [评论]" : "") +
                (i.llmEnabled ? " [LLM]" : "") +
                (i.hasPassword ? " 🔒" : "") +
                (i.expiresAt ? ` (过期于 ${new Date(i.expiresAt).toISOString()})` : ""),
            )
            .join("\n")
        : "还没有任何分享。";
      return ok(text, { count: items.length, shares: items });
    },
  }),

  defineTool({
    name: "set_page_state_enabled",
    description: "启用或停用 HTML 分享的共享页面数据。所有能访问分享的访客都可读写；停用保留数据，重新启用后恢复。",
    inputSchema: z.object({
      slug: slugArg,
      enabled: z.boolean().describe("true 启用，false 停用"),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setSharePageStateEnabledFor(user.id, share.id, args.enabled);
        if (res.error) return fail(res.error);
        return ok(args.enabled ? "已启用共享页面数据" : "已停用共享页面数据（数据仍保留）", {
          slug: args.slug,
          pageStateEnabled: args.enabled,
        });
      }),
  }),

  defineTool({
    name: "reset_page_state",
    description: "清空一个已启用共享数据的 HTML 分享的页面 JSON，并递增版本使旧客户端写入冲突。只能操作自己的分享。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = resetSharePageStateFor(user.id, share.id);
        if (res.error) return fail(res.error);
        return ok("已清空共享页面数据", { slug: args.slug, reset: true });
      }),
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

  defineTool({
    name: "set_visitor_state_enabled",
    description:
      "启用或停用 HTML 分享的访客私有数据。启用后每个访客有独立可写 JSON，互不可见；页面需引入 /sdk/page-state-v1.js 并使用 GalleryVisitorState。",
    inputSchema: z.object({
      slug: slugArg,
      enabled: z.boolean().describe("true 启用，false 停用"),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareVisitorStateEnabledFor(user.id, share.id, args.enabled);
        if (res.error) return fail(res.error);
        return ok(
          args.enabled ? "已启用访客数据" : "已停用访客数据（数据仍保留）",
          { slug: args.slug, visitorStateEnabled: args.enabled },
        );
      }),
  }),

  defineTool({
    name: "reset_visitor_state",
    description:
      "清空访客数据。visitorKey 给定时只清该访客；省略时清整份分享的所有访客数据。只能操作自己的分享。",
    inputSchema: z.object({
      slug: slugArg,
      visitorKey: z
        .string()
        .max(64)
        .optional()
        .describe("可选：只清空这一个访客的数据；省略则清空所有访客"),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = resetShareVisitorStateFor(user.id, share.id, args.visitorKey);
        if (res.error) return fail(res.error);
        return ok(
          args.visitorKey ? "已清空该访客的数据" : "已清空所有访客数据",
          { slug: args.slug, reset: true },
        );
      }),
  }),

  defineTool({
    name: "list_share_files",
    description:
      "列出一个分享下的所有文件（path、mimeType、大小）。多文件 artifact 用它看结构；只能操作自己的分享。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const files = listShareFiles(share.id).map((f) => ({
          path: f.path,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          isEntry: f.path === share.entryPath,
        }));
        const text = files.length
          ? files
              .map((f) => `• ${f.path}${f.isEntry ? " [入口]" : ""} — ${f.sizeBytes} B`)
              .join("\n")
          : "没有文件。";
        return ok(text, {
          slug: args.slug,
          entryPath: share.entryPath,
          count: files.length,
          files,
        });
      }),
  }),

  defineTool({
    name: "update_share_file",
    description:
      "更新 share 里单个文件的内容（覆盖已有 path 或新增 path）。用于已发布 artifact 的原地修改——slug/URL 不变。入口文件的 kind 不能变。",
    inputSchema: z.object({
      slug: slugArg,
      path: z
        .string()
        .min(1)
        .max(512)
        .describe("share 内相对路径，如 index.html / js/app.js"),
      content: z.string().describe("文件内容。文本给字符串；二进制给 base64 且 encoding=base64"),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
    }),
    handler: async (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        if (!isValidSharePath(args.path)) return fail(`非法文件路径：${args.path}`);
        const buf = Buffer.from(
          args.content,
          args.encoding === "base64" ? "base64" : "utf8",
        );
        if (buf.length === 0) return fail("文件内容为空");
        const env = getEnv();
        if (buf.length > env.maxFileSizeBytes) return fail(fileTooLargeMessage());
        if (args.path === share.entryPath) {
          if (share.runtime === "react" && !/\.(jsx|tsx)$/i.test(args.path)) {
            return fail("React Artifact 入口必须是 .jsx 或 .tsx");
          }
          if (share.runtime === "static" && classifyFile(args.path).kind !== share.kind) {
            return fail(`入口文件类型不能从 ${share.kind} 变为 ${classifyFile(args.path).kind}`);
          }
        }

        // 落盘 → upsert DB（upsert 内部会记一个"变更后"版本快照）
        await saveFile(share.id, args.path, buf);
        const res = await upsertShareFileFor(user.id, share.id, args.path, buf.length);
        if (res.error) return fail(res.error);
        return ok(
          res.isNew
            ? `已新增文件 ${args.path}`
            : `已更新文件 ${args.path}（链接不变）`,
          {
            slug: args.slug,
            path: args.path,
            sizeBytes: buf.length,
            isEntry: res.isEntry === true,
          },
        );
      }),
  }),

  defineTool({
    name: "upload_share_files",
    description:
      "批量上传/更新 share 的多个文件（多文件 artifact 发布）。files[] 里每个元素是 {path, content, encoding?}。entryPath 可选，默认沿用现有入口。",
    inputSchema: z.object({
      slug: slugArg,
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(512),
            content: z.string(),
            encoding: z.enum(["utf8", "base64"]).default("utf8"),
          }),
        )
        .min(1)
        .max(255)
        .describe("要上传/更新的文件列表"),
      entryPath: z
        .string()
        .max(512)
        .optional()
        .describe("可选：修改入口文件路径；不填则保持现有入口"),
    }),
    handler: async (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        const env = getEnv();
        // 先全部校验再落盘：任一文件失败则整批不写
        const prepared: Array<{ path: string; buf: Buffer }> = [];
        const seen = new Set<string>();
        for (const f of args.files) {
          if (!isValidSharePath(f.path)) {
            return fail(`非法文件路径：${f.path}`);
          }
          if (seen.has(f.path)) return fail(`重复的文件路径：${f.path}`);
          seen.add(f.path);
          const buf = Buffer.from(
            f.content,
            f.encoding === "base64" ? "base64" : "utf8",
          );
          if (buf.length === 0) return fail(`文件 ${f.path} 内容为空`);
          if (buf.length > env.maxFileSizeBytes) return fail(fileTooLargeMessage());
          prepared.push({ path: f.path, buf });
        }

        // entryPath 校验：必须在现有文件或本批上传中
        const targetEntry = args.entryPath ?? share.entryPath;
        if (share.runtime === "react" && !/\.(jsx|tsx)$/i.test(targetEntry)) {
          return fail("React Artifact 入口必须是 .jsx 或 .tsx");
        }
        if (args.entryPath !== undefined) {
          const existsInBatch = prepared.some((f) => f.path === targetEntry);
          const existsInDb =
            !existsInBatch &&
            listShareFiles(share.id).some((f) => f.path === targetEntry);
          if (!existsInBatch && !existsInDb) {
            return fail(`入口文件 ${targetEntry} 不存在`);
          }
        }

        // 落盘 + 写库（事务内），最后再记一个"变更后"版本快照
        for (const f of prepared) {
          await saveFile(share.id, f.path, f.buf);
        }

        const db = getDb();
        db.transaction((tx) => {
          for (const f of prepared) {
            // upsertShareFileFor 内部再做一次事务会嵌套；这里直接展开
            const { mimeType } = classifyFile(f.path);
            const now = Date.now();
            const existing = tx
              .select()
              .from(shareFiles)
              .where(
                and(
                  eq(shareFiles.shareId, share.id),
                  eq(shareFiles.path, f.path),
                ),
              )
              .get();
            if (existing) {
              tx.update(shareFiles)
                .set({ mimeType, sizeBytes: f.buf.length, updatedAt: now })
                .where(
                  and(
                    eq(shareFiles.shareId, share.id),
                    eq(shareFiles.path, f.path),
                  ),
                )
                .run();
            } else {
              tx.insert(shareFiles)
                .values({
                  shareId: share.id,
                  path: f.path,
                  mimeType,
                  sizeBytes: f.buf.length,
                  createdAt: now,
                  updatedAt: now,
                })
                .run();
            }
          }
          const entryInfo = prepared.find((f) => f.path === targetEntry);
          const { kind: entryKind, mimeType: entryMime } = classifyFile(targetEntry);
          const entrySize = entryInfo
            ? entryInfo.buf.length
            : (listShareFiles(share.id).find((f) => f.path === targetEntry)?.sizeBytes ?? 0);
          tx.update(shares)
            .set({
              updatedAt: Date.now(),
              entryPath: targetEntry,
              kind: share.runtime === "react" ? "html" : entryKind,
              mimeType: share.runtime === "react" ? "text/html" : entryMime,
              size: entrySize,
              originalName:
                targetEntry.split("/").pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) ||
                share.originalName,
            })
            .where(eq(shares.id, share.id))
            .run();
        });

        // 变更后版本快照
        try {
          const refreshed = getDb()
            .select()
            .from(shares)
            .where(eq(shares.id, share.id))
            .get();
          if (refreshed) await snapshotVersion(refreshed);
        } catch (e) {
          console.error("snapshot after upload_share_files failed:", e);
        }

        return ok(`已上传 ${prepared.length} 个文件到 ${args.slug}`, {
          slug: args.slug,
          uploaded: prepared.length,
          entryPath: targetEntry,
        });
      }),
  }),

  defineTool({
    name: "delete_share_file",
    description:
      "从多文件 share 里删除一个 path。入口文件不可删（会毁掉整个分享）。只能操作自己的分享。",
    inputSchema: z.object({
      slug: slugArg,
      path: z.string().min(1).max(512),
    }),
    handler: async (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        const res = await deleteShareFileFor(user.id, share.id, args.path);
        if (res.error) return fail(res.error);
        return ok(`已删除 ${args.path}`, { slug: args.slug, path: args.path });
      }),
  }),

  // —— KV 行集 ——
  defineTool({
    name: "set_kv_enabled",
    description: "启用或停用 HTML 分享的行级共享数据（collection/key 行集）。",
    inputSchema: z.object({ slug: slugArg, enabled: z.boolean() }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareKvEnabledFor(user.id, share.id, args.enabled);
        if (res.error) return fail(res.error);
        return ok(args.enabled ? "已启用行集数据" : "已停用（数据保留）", {
          slug: args.slug,
          kvEnabled: args.enabled,
        });
      }),
  }),

  defineTool({
    name: "set_attachments_enabled",
    description: "启用或停用 HTML 分享的访客附件上传、下载和删除能力。",
    inputSchema: z.object({ slug: slugArg, enabled: z.boolean() }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareAttachmentsEnabledFor(user.id, share.id, args.enabled);
        return res.error ? fail(res.error) : ok(args.enabled ? "已启用访客附件" : "已停用访客附件", {
          attachmentsEnabled: args.enabled,
        });
      }),
  }),

  defineTool({
    name: "kv_list",
    description:
      "列出一个 collection 下的行。支持 prefix 前缀过滤与 cursor 分页；只能操作自己的分享。",
    inputSchema: z.object({
      slug: slugArg,
      collection: z.string().min(1).max(64),
      prefix: z.string().max(256).optional(),
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        if (!isValidCollection(args.collection)) return fail("非法 collection");
        const { items, nextCursor } = kvList(share.id, args.collection, {
          prefix: args.prefix,
          cursor: args.cursor,
          limit: args.limit,
        });
        const text = items.length
          ? items.map((i) => `• ${i.key} (v${i.version}) — ${i.sizeBytes} B`).join("\n")
          : "没有行。";
        return ok(text, { count: items.length, nextCursor, items });
      }),
  }),

  defineTool({
    name: "kv_get",
    description: "读一行数据。",
    inputSchema: z.object({
      slug: slugArg,
      collection: z.string().min(1).max(64),
      key: z.string().min(1).max(256),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const item = kvGet(share.id, args.collection, args.key);
        if (!item) return fail("行不存在");
        return ok(JSON.stringify(item.value, null, 2), { item });
      }),
  }),

  defineTool({
    name: "kv_put",
    description:
      "写一行。baseVersion 提供则做 CAS；ifAbsent=true 则要求行不存在（create-only）。",
    inputSchema: z.object({
      slug: slugArg,
      collection: z.string().min(1).max(64),
      key: z.string().min(1).max(256),
      value: z.unknown().describe("任意 JSON 值"),
      baseVersion: z.number().int().nonnegative().optional(),
      ifAbsent: z.boolean().optional(),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        if (!isValidCollection(args.collection) || !isValidKvKey(args.key)) {
          return fail("非法 collection 或 key");
        }
        const valueJson = JSON.stringify(args.value);
        if (valueJson === undefined) return fail("值不能是 undefined");
        const sizeBytes = Buffer.byteLength(valueJson);
        const env = getEnv();
        if (sizeBytes > env.maxPageStateSizeBytes) {
          return fail(`值超过大小限制（${env.maxPageStateSizeBytes / 1024}KB）`);
        }
        const isNew = kvGet(share.id, args.collection, args.key) === null;
        if (isNew && kvCountRows(share.id) >= 5000) {
          return fail("行数已达上限");
        }
        const r = kvPut(share.id, args.collection, args.key, valueJson, sizeBytes, {
          baseVersion: args.baseVersion,
          ifAbsent: args.ifAbsent,
        });
        if (r.status === "conflict") {
          return fail(`版本冲突：当前 v${r.item.version}，你基于 v${args.baseVersion ?? "?"}`);
        }
        if (r.status === "not_found") return fail("行不存在");
        return ok(`已写入 ${args.collection}/${args.key} (v${r.item.version})`, {
          item: r.item,
        });
      }),
  }),

  defineTool({
    name: "kv_delete",
    description: "删一行。baseVersion 提供则做 CAS。",
    inputSchema: z.object({
      slug: slugArg,
      collection: z.string().min(1).max(64),
      key: z.string().min(1).max(256),
      baseVersion: z.number().int().nonnegative().optional(),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const r = kvDelete(share.id, args.collection, args.key, args.baseVersion);
        if (r.status === "not_found") return fail("行不存在");
        if (r.status === "conflict") {
          return fail(`版本冲突：当前 v${r.item.version}`);
        }
        return ok(`已删除 ${args.collection}/${args.key}`, { deleted: true });
      }),
  }),

  defineTool({
    name: "kv_clear_collection",
    description: "清空一个 collection 的所有行。",
    inputSchema: z.object({
      slug: slugArg,
      collection: z.string().min(1).max(64),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = clearShareKvCollectionFor(user.id, share.id, args.collection);
        if (res.error) return fail(res.error);
        return ok(`已清空 ${args.collection}（删除 ${res.cleared ?? 0} 行）`, {
          cleared: res.cleared ?? 0,
        });
      }),
  }),

  // —— 展示、排序与 Remix ——
  defineTool({
    name: "update_share_metadata",
    description: "更新标题、描述、Emoji 图标、OG 封面路径和公开源码开关。",
    inputSchema: z.object({
      slug: slugArg,
      title: z.string().max(120).nullable(),
      description: z.string().max(500),
      icon: z.string().max(16),
      coverPath: z.string().max(512).nullable(),
      sourceEnabled: z.boolean(),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareMetadataFor(user.id, share.id, args);
        return res.error ? fail(res.error) : ok("分享元数据已更新", { slug: args.slug });
      }),
  }),

  defineTool({
    name: "fork_share",
    description: "Fork 自己的分享：复制当前文件和能力配置，不复制数据、附件、评论或历史。",
    inputSchema: z.object({ slug: slugArg }),
    handler: async (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        const res = await forkShareFor(user.id, share.id);
        return res.error ? fail(res.error) : ok(`已创建 Fork /s/${res.slug}`, res);
      }),
  }),

  defineTool({
    name: "set_share_pinned",
    description: "固定或取消固定文件列表中的分享。",
    inputSchema: z.object({ slug: slugArg, pinned: z.boolean() }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setSharePinnedFor(user.id, share.id, args.pinned);
        return res.error ? fail(res.error) : ok(args.pinned ? "已固定" : "已取消固定");
      }),
  }),

  defineTool({
    name: "move_share",
    description: "在文件列表中上移或下移一个分享。direction=-1 上移，1 下移。",
    inputSchema: z.object({ slug: slugArg, direction: z.union([z.literal(-1), z.literal(1)]) }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = moveShareFor(user.id, share.id, args.direction);
        return res.error ? fail(res.error) : ok("列表顺序已更新");
      }),
  }),

  // —— 数据版本与访问策略 ——
  defineTool({
    name: "set_data_schema_version",
    description: "设置 Artifact 的数据结构版本。页面声明的版本不一致时读写会返回冲突。",
    inputSchema: z.object({ slug: slugArg, version: z.number().int().positive() }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareDataSchemaVersionFor(user.id, share.id, args.version);
        return res.error ? fail(res.error) : ok(`数据 schema 已设为 v${args.version}`, {
          dataSchemaVersion: args.version,
        });
      }),
  }),

  defineTool({
    name: "reset_data_space",
    description: "危险：永久清空共享页面、访客私有数据和 KV，并递增 dataGeneration。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = resetShareDataSpaceFor(user.id, share.id);
        return res.error ? fail(res.error) : ok(`已创建数据空间 #${res.dataGeneration}`, {
          dataGeneration: res.dataGeneration,
        });
      }),
  }),

  defineTool({
    name: "set_kv_policy",
    description: "设置 collection 的 read/write/delete 权限。read 仅支持 all/owner；creator 表示行创建者。",
    inputSchema: z.object({
      slug: slugArg,
      collection: z.string().min(1).max(64),
      readMode: z.enum(["all", "owner"]),
      writeMode: z.enum(["all", "owner", "creator"]),
      deleteMode: z.enum(["all", "owner", "creator"]),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const policy = {
          collection: args.collection,
          readMode: args.readMode,
          writeMode: args.writeMode,
          deleteMode: args.deleteMode,
        };
        const res = setShareKvPolicyFor(user.id, share.id, policy);
        return res.error ? fail(res.error) : ok(`已保存 ${args.collection} 的 KV 权限`, {
          policy: getKvPolicy(share.id, args.collection),
        });
      }),
  }),

  // —— 版本历史 ——
  defineTool({
    name: "list_versions",
    description: "列出分享的所有历史版本（最新在前）。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const versions = listVersions(share.id);
        const text = versions.length
          ? versions
              .map(
                (v) =>
                  `• v${v.versionNo}${v.label ? ` (${v.label})` : ""} — ${v.fileCount} 个文件 · ${new Date(v.createdAt).toISOString()}`,
              )
              .join("\n")
          : "还没有版本历史。";
        return ok(text, { count: versions.length, versions });
      }),
  }),

  defineTool({
    name: "publish_version",
    description:
      "为当前状态打一个带标签的版本（对齐 artifact 的 label）。不改变文件，只是记一条 manifest。",
    inputSchema: z.object({
      slug: slugArg,
      label: z.string().min(1).max(100).describe("版本标签，如 'draft 2' / 'phase 1 cut'"),
      dataMode: z.enum(["keep", "new"]).default("keep").describe("keep 沿用数据；new 清空并创建新数据空间"),
    }),
    handler: async (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        const res = await publishShareVersionFor(user.id, share.id, args.label, args.dataMode);
        if (res.error) return fail(res.error);
        return ok(`已发布 v${res.versionNo}（${args.label}）`, {
          slug: args.slug,
          versionNo: res.versionNo,
          label: args.label,
        });
      }),
  }),

  defineTool({
    name: "rollback_to_version",
    description:
      "回滚到指定版本：把该版本的文件物化回当前 files/，并产出一个新版本（历史只增不减）。",
    inputSchema: z.object({
      slug: slugArg,
      versionNo: z.number().int().positive().describe("要回滚到的版本号"),
    }),
    handler: async (user, args) =>
      withOwnedShare(user.id, args.slug, async (share) => {
        const result = await rollbackShareVersionFor(user.id, share.id, args.versionNo);
        if (result.error) return fail(result.error);
        return ok(`已回滚到 v${args.versionNo}（产生新版本 v${result.versionNo}）`, {
          slug: args.slug,
          rolledBackTo: args.versionNo,
          newVersionNo: result.versionNo,
        });
      }),
  }),

  // —— 评论 ——
  defineTool({
    name: "set_comments_enabled",
    description: "启用或停用分享的评论面板（任何 kind 可用）。",
    inputSchema: z.object({ slug: slugArg, enabled: z.boolean() }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareCommentsEnabledFor(user.id, share.id, args.enabled);
        if (res.error) return fail(res.error);
        return ok(args.enabled ? "已启用评论" : "已停用评论（数据保留）", {
          slug: args.slug,
          commentsEnabled: args.enabled,
        });
      }),
  }),

  defineTool({
    name: "set_comments_visitor_write",
    description: "设置是否允许非 owner 访客发表评论；关闭后评论只读。",
    inputSchema: z.object({ slug: slugArg, enabled: z.boolean() }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareCommentsVisitorWriteFor(user.id, share.id, args.enabled);
        return res.error ? fail(res.error) : ok(args.enabled ? "已允许访客评论" : "已禁止访客评论", {
          commentsVisitorWrite: args.enabled,
        });
      }),
  }),

  defineTool({
    name: "list_comments",
    description: "列出分享的所有评论（含隐藏）。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const items = listComments(share.id, { includeHidden: true });
        const text = items.length
          ? items
              .map(
                (c) =>
                  `• [${c.status}]${c.isOwner ? " [站长]" : ""} ${c.authorLabel}: ${c.body.slice(0, 80)}${c.body.length > 80 ? "…" : ""}`,
              )
              .join("\n")
          : "没有评论。";
        return ok(text, { count: items.length, comments: items });
      }),
  }),

  defineTool({
    name: "reply_comment",
    description: "以 owner 身份发表一条评论（标记为站长）。",
    inputSchema: z.object({
      slug: slugArg,
      body: z.string().min(1).max(2000),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const item = addComment({
          shareId: share.id,
          visitorKey: null,
          authorLabel: "站长",
          body: args.body,
          isOwner: true,
        });
        return ok("已发表评论", { comment: item });
      }),
  }),

  defineTool({
    name: "set_comment_status",
    description: "改评论状态：open / resolved / hidden。",
    inputSchema: z.object({
      slug: slugArg,
      commentId: z.string().min(1),
      status: z.enum(["open", "resolved", "hidden"]),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareCommentStatusFor(
          user.id,
          share.id,
          args.commentId,
          args.status,
        );
        return res.error
          ? fail(res.error)
          : ok(`已标记 ${args.status}`, { commentId: args.commentId, status: args.status });
      }),
  }),

  defineTool({
    name: "ban_visitor",
    description: "按 visitorKey 屏蔽某访客的评论权限。",
    inputSchema: z.object({
      slug: slugArg,
      visitorKey: z.string().min(8).max(64),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        banVisitor(share.id, args.visitorKey);
        return ok(`已屏蔽访客 ${args.visitorKey}`, {
          slug: args.slug,
          visitorKey: args.visitorKey,
        });
      }),
  }),

  defineTool({
    name: "unban_visitor",
    description: "解除某访客的评论屏蔽。",
    inputSchema: z.object({
      slug: slugArg,
      visitorKey: z.string().min(8).max(64),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        unbanVisitor(share.id, args.visitorKey);
        return ok(`已解除屏蔽 ${args.visitorKey}`, {
          slug: args.slug,
          visitorKey: args.visitorKey,
        });
      }),
  }),

  // —— LLM ——
  defineTool({
    name: "set_llm_enabled",
    description:
      "启用或停用页面内 LLM 调用。仅 HTML；需服务端已配置 LLM_BASE_URL/LLM_API_KEY。",
    inputSchema: z.object({
      slug: slugArg,
      enabled: z.boolean(),
      dailyTokenBudget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("可选：覆盖每日 token 预算"),
      model: z.string().max(100).optional().describe("可选：覆盖默认模型"),
    }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const res = setShareLlmEnabledFor(user.id, share.id, {
          enabled: args.enabled,
          dailyTokenBudget: args.dailyTokenBudget,
          model: args.model,
        });
        if (res.error) return fail(res.error);
        return ok(args.enabled ? "已启用 LLM" : "已停用 LLM", {
          slug: args.slug,
          llmEnabled: args.enabled,
          dailyTokenBudget: args.dailyTokenBudget ?? share.llmDailyTokenBudget,
          model: args.model ?? share.llmModel,
        });
      }),
  }),

  defineTool({
    name: "llm_usage",
    description: "查看 LLM 今日用量（tokens 统计与剩余额度）。",
    inputSchema: z.object({ slug: slugArg }),
    handler: (user, args) =>
      withOwnedShare(user.id, args.slug, (share) => {
        const stats = getLlmUsageToday(share);
        return ok(
          `今日已用 ${stats.tokensToday} / ${stats.dailyBudget} tokens（剩余 ${stats.remaining}）`,
          { ...stats },
        );
      }),
  }),
];
