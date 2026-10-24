import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { classifyFile } from "@/lib/file-kind";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import {
  callLlm,
  getLlmUsageToday,
  recordUsage,
  releaseLlmCapacity,
  reserveLlmCapacity,
} from "@/lib/shares/llm";
import { listShareFiles, upsertShareFileFor } from "@/lib/shares/manage";
import { isValidSharePath, readFileText, saveFile } from "@/lib/storage";

const MAX_CONTEXT_BYTES = 64 * 1024;
const modifySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "files"],
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  },
} as const;
const modifyResultSchema = z.object({
  summary: z.string().max(2000),
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    content: z.string().max(512 * 1024),
  }).strict()).max(10),
}).strict();
const bodySchema = z.object({
  action: z.enum(["ask", "modify"]),
  prompt: z.string().min(1).max(8192),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(16 * 1024),
  }).strict()).max(12).default([]),
}).strict();

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  if (!isValidOrigin(request)) return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  const userAccess = await resolveShareAccess((await ctx.params).slug);
  if (userAccess.status === "not_found") return json({ error: "分享不存在" }, 404);
  if (userAccess.status === "locked" || !userAccess.isOwner || !userAccess.user) {
    return json({ error: "仅 owner 可以使用 Artifact AI", code: "owner_only" }, 403);
  }
  const share = userAccess.share;
  if (!getEnv().llm) return json({ error: "服务端未配置 LLM", code: "not_configured" }, 503);
  const ip = await getClientIp();
  if (!rateLimit(`artifact-ai:${ip}:${share.id}`, 10, 60_000)) {
    return json({ error: "请求过于频繁", code: "rate_limited" }, 429);
  }
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: "JSON 格式不正确" }, 400); }
  const parsed = bodySchema.safeParse(input);
  if (!parsed.success) return json({ error: "请求参数不正确" }, 400);

  let contextBytes = 0;
  const sourceParts: string[] = [];
  for (const file of listShareFiles(share.id)) {
    if (!file.mimeType.startsWith("text/") || contextBytes >= MAX_CONTEXT_BYTES) continue;
    try {
      const content = await readFileText(share.id, file.path);
      const part = `--- ${file.path} ---\n${content}`;
      sourceParts.push(part.slice(0, MAX_CONTEXT_BYTES - contextBytes));
      contextBytes = Math.min(MAX_CONTEXT_BYTES, contextBytes + Buffer.byteLength(part));
    } catch {}
  }
  const system = [
    "你是 Gallery 的 Artifact 助手。你可以读取下面提供的当前源码。",
    parsed.data.action === "modify"
      ? "请直接修改源码以满足要求。只返回符合 schema 的 JSON：summary 以及需要新增或完整覆盖的 files；不要返回 Markdown，不要删除未列出的文件。"
      : "请回答 owner 关于此 Artifact 的问题；不要假装已修改文件。",
    `入口：${share.entryPath}；运行时：${share.runtime} ${share.runtimeVersion}`,
    sourceParts.length ? sourceParts.join("\n\n") : "没有可读取的文本源码。",
  ].join("\n\n");
  const reservation = reserveLlmCapacity(share, `user:${userAccess.user.id}`);
  if ("error" in reservation) return json({ error: reservation.error, code: reservation.code }, 429);
  try {
    const result = await callLlm(share, {
      messages: [
        { role: "system", content: system },
        ...parsed.data.messages,
        { role: "user", content: parsed.data.prompt },
      ],
      responseSchema: parsed.data.action === "modify" ? modifySchema : undefined,
      signal: request.signal,
    });
    if ("code" in result) {
      if (result.tokensIn || result.tokensOut) {
        recordUsage(share.id, `user:${userAccess.user.id}`, result.tokensIn ?? 0, result.tokensOut ?? 0);
      }
      return json({ error: result.message, code: result.code }, result.code === "aborted" ? 499 : 502);
    }
    recordUsage(share.id, `user:${userAccess.user.id}`, result.tokensIn, result.tokensOut);
    if (parsed.data.action === "ask") {
      return json({ text: result.text, modifiedFiles: [], usage: getLlmUsageToday(share) });
    }
    let modified: z.infer<typeof modifyResultSchema>;
    try { modified = modifyResultSchema.parse(JSON.parse(result.text)); }
    catch { return json({ error: "模型没有返回有效的文件修改", code: "invalid_structured_output" }, 502); }
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of modified.files) {
      if (!isValidSharePath(file.path) || paths.has(file.path)) {
        return json({ error: `模型返回了非法或重复路径：${file.path}`, code: "invalid_file_change" }, 502);
      }
      paths.add(file.path);
      totalBytes += Buffer.byteLength(file.content);
      if (totalBytes > 2 * 1024 * 1024) return json({ error: "模型修改总量超过限制" }, 413);
      if (file.path === share.entryPath) {
        if (share.runtime === "react" && !/\.(jsx|tsx)$/i.test(file.path)) {
          return json({ error: "React 入口必须是 .jsx 或 .tsx", code: "invalid_file_change" }, 502);
        }
        if (share.runtime === "static" && classifyFile(file.path).kind !== share.kind) {
          return json({ error: "模型修改会改变入口文件类型", code: "invalid_file_change" }, 502);
        }
      }
    }
    for (const file of modified.files) {
      const content = new TextEncoder().encode(file.content);
      await saveFile(share.id, file.path, content);
      const mutation = await upsertShareFileFor(userAccess.user.id, share.id, file.path, content.byteLength);
      if (mutation.error) return json({ error: mutation.error, code: "file_change_rejected" }, 400);
    }
    return json({ text: modified.summary, modifiedFiles: [...paths], usage: getLlmUsageToday(share) });
  } finally {
    releaseLlmCapacity(reservation);
  }
}
