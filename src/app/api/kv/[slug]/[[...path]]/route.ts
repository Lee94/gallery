import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Share } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { isValidOrigin } from "@/lib/request-origin";
import { resolveShareAccess } from "@/lib/share-access";
import { checkDataCompatibility } from "@/lib/shares/data-compatibility";
import {
  getKvPolicy,
  canReadKvPolicy,
  canMutateKvPolicy,
  isValidCollection,
  isValidKvKey,
  kvBatch,
  kvClearCollection,
  kvCountRows,
  kvDelete,
  kvGet,
  kvGetRecord,
  kvList,
  kvPut,
  newKvKey,
  type KvBatchOp,
} from "@/lib/shares/kv";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const BODY_WRAPPER_LIMIT = 16 * 1024;
const MAX_OPS = 50;
const MAX_ROWS_PER_SHARE = 5000;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function notFound(msg = "数据不存在"): NextResponse {
  return json({ error: msg, code: "not_found" }, 404);
}

async function readBodyWithLimit(
  request: NextRequest,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

type Access = { share: Share; isOwner: boolean; actorKey: string | null } | { response: NextResponse };

async function resolveAccess(slug: string, request: NextRequest): Promise<Access> {
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") return { response: notFound("数据不可用") };
  if (access.status === "locked") {
    return {
      response: json(
        { error: "请先输入分享访问密码", code: "locked" },
        403,
      ),
    };
  }
  if (!access.share.kvEnabled) return { response: notFound("行集数据未启用") };
  const incompatible = checkDataCompatibility(request.headers, access.share);
  if (incompatible) return { response: json(incompatible.body, incompatible.status) };
  const rawVisitorKey = request.headers.get("x-gallery-visitor-key");
  const visitorKey = rawVisitorKey && /^[a-zA-Z0-9_-]{8,64}$/.test(rawVisitorKey)
    ? rawVisitorKey
    : null;
  return {
    share: access.share,
    isOwner: access.isOwner,
    actorKey: access.user ? `user:${access.user.id}` : visitorKey,
  };
}

function forbidden(message = "没有该数据操作的权限"): NextResponse {
  return json({ error: message, code: "forbidden" }, 403);
}

/**
 * URL 形态：
 *   GET    /api/kv/<slug>/<collection>           → list（query: prefix/cursor/limit）
 *   GET    /api/kv/<slug>/<collection>/<key>     → get
 *   PUT    /api/kv/<slug>/<collection>[/<key>]   → put（body {value, baseVersion?, ifAbsent?, key?}；key 省略则服务端发 nanoid）
 *   DELETE /api/kv/<slug>/<collection>/<key>?baseVersion=
 *   POST   /api/kv/<slug>/batch                  → {ops: [...]}
 *   DELETE /api/kv/<slug>/<collection>           → clear collection（仅 owner）
 *
 * path 段拼接规则：collection 必须首段合法；key 是其后所有段 join("/")。
 */
function parsePath(segments: string[] | undefined): {
  collection: string;
  key?: string;
} | null {
  if (!segments || segments.length === 0) return null;
  const collection = decodeURIComponent(segments[0]!);
  if (!isValidCollection(collection)) return null;
  const key = segments.length > 1
    ? segments.slice(1).map(decodeURIComponent).join("/")
    : undefined;
  if (key !== undefined && !isValidKvKey(key)) return null;
  return { collection, key };
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  const { slug, path } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;

  const parsed = parsePath(path);
  if (!parsed) return notFound();
  const policy = getKvPolicy(access.share.id, parsed.collection);
  if (!canReadKvPolicy(policy, access.isOwner)) return forbidden("该 collection 仅 owner 可读");

  const ip = await getClientIp();
  if (!rateLimit(`kv-read:${ip}:${access.share.id}`, 120, 60_000)) {
    return json({ error: "读取过于频繁", code: "rate_limited" }, 429);
  }

  if (parsed.key !== undefined) {
    const item = kvGet(access.share.id, parsed.collection, parsed.key);
    return item ? json(item) : notFound();
  }

  const sp = request.nextUrl.searchParams;
  const { items, nextCursor } = kvList(access.share.id, parsed.collection, {
    prefix: sp.get("prefix") ?? undefined,
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
  });
  return json({ items, nextCursor });
}

const putBodySchema = z
  .object({
    key: z.string().max(256).optional(), // 指定 key（仅当 URL 无 key 时）
    value: z.unknown(),
    baseVersion: z.number().int().nonnegative().optional(),
    ifAbsent: z.boolean().optional(),
  })
  .strict();

export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  if (!isValidOrigin(request)) {
    return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  }
  const { slug, path } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;

  const parsed = parsePath(path);
  if (!parsed) return notFound();

  const ip = await getClientIp();
  if (!rateLimit(`kv-write:${ip}:${access.share.id}`, 30, 60_000)) {
    return json({ error: "写入过于频繁", code: "rate_limited" }, 429);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    return json({ error: "请求必须使用 JSON", code: "invalid_content_type" }, 415);
  }

  const maxStateBytes = getEnv().maxPageStateSizeBytes;
  const maxBodyBytes = maxStateBytes + BODY_WRAPPER_LIMIT;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBodyBytes) {
    return json({ error: "值过大", code: "value_too_large" }, 413);
  }

  let rawBody: string | null;
  try {
    rawBody = await readBodyWithLimit(request, maxBodyBytes);
  } catch {
    return json({ error: "请求体不是合法 UTF-8", code: "invalid_json" }, 400);
  }
  if (rawBody === null) {
    return json({ error: "值过大", code: "value_too_large" }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "JSON 格式不正确", code: "invalid_json" }, 400);
  }
  const parsedBody = putBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return json({ error: "请求参数不正确", code: "invalid_request" }, 400);
  }

  const key = parsed.key ?? parsedBody.data.key ?? newKvKey();
  if (!isValidKvKey(key)) {
    return json({ error: "非法 key", code: "invalid_key" }, 400);
  }
  const policy = getKvPolicy(access.share.id, parsed.collection);
  const existingRecord = kvGetRecord(access.share.id, parsed.collection, key);
  if (
    !canMutateKvPolicy(
      policy,
      "write",
      access.isOwner,
      access.actorKey,
      existingRecord?.creatorKey ?? access.actorKey,
    )
  ) {
    return forbidden("只有行创建者或 owner 可以覆盖这行数据");
  }

  let valueJson: string | undefined;
  try {
    valueJson = JSON.stringify(parsedBody.data.value);
  } catch {
    return json({ error: "值无法序列化", code: "invalid_data" }, 400);
  }
  if (valueJson === undefined) {
    return json({ error: "缺少值", code: "invalid_request" }, 400);
  }
  const sizeBytes = Buffer.byteLength(valueJson);
  if (sizeBytes > maxStateBytes) {
    return json({ error: "值过大", code: "value_too_large" }, 413);
  }

  // 行数硬上限：新增行才检查
  const isNewRow = existingRecord === null;
  if (isNewRow && kvCountRows(access.share.id) >= MAX_ROWS_PER_SHARE) {
    return json({ error: "行数已达上限", code: "too_many_rows" }, 413);
  }

  const result = kvPut(access.share.id, parsed.collection, key, valueJson, sizeBytes, {
    baseVersion: parsedBody.data.baseVersion,
    ifAbsent: parsedBody.data.ifAbsent,
    creatorKey: access.actorKey,
  });
  if (result.status === "not_found") return notFound();
  if (result.status === "conflict") {
    return json(
      { error: "数据已被修改", code: "version_conflict", item: result.item },
      409,
    );
  }
  return json(result.item);
}

const batchOpSchema = z
  .object({
    op: z.enum(["put", "del"]),
    collection: z.string().min(1).max(64),
    key: z.string().min(1).max(256),
    value: z.unknown().optional(),
    baseVersion: z.number().int().nonnegative().optional(),
    ifAbsent: z.boolean().optional(),
  })
  .strict();
const batchBodySchema = z
  .object({ ops: z.array(batchOpSchema).min(1).max(MAX_OPS) })
  .strict();

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  if (!isValidOrigin(request)) {
    return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  }
  const { slug, path } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;

  // 只允许 /api/kv/<slug>/batch
  const segs = path ?? [];
  if (segs.length !== 1 || decodeURIComponent(segs[0]!) !== "batch") {
    return notFound();
  }

  const ip = await getClientIp();
  if (!rateLimit(`kv-write:${ip}:${access.share.id}`, 30, 60_000)) {
    return json({ error: "写入过于频繁", code: "rate_limited" }, 429);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    return json({ error: "请求必须使用 JSON", code: "invalid_content_type" }, 415);
  }

  const maxStateBytes = getEnv().maxPageStateSizeBytes;
  const maxBodyBytes = maxStateBytes * MAX_OPS + BODY_WRAPPER_LIMIT;
  const raw = await readBodyWithLimit(request, maxBodyBytes).catch(() => null);
  if (raw === null) return json({ error: "请求体过大", code: "too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "JSON 格式不正确", code: "invalid_json" }, 400);
  }
  const parsedBody = batchBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return json({ error: "请求参数不正确", code: "invalid_request" }, 400);
  }

  // 逐 op 校验 + 序列化 value → valueJson
  const maxValue = maxStateBytes;
  const ops: KvBatchOp[] = [];
  for (const o of parsedBody.data.ops) {
    if (!isValidCollection(o.collection) || !isValidKvKey(o.key)) {
      return json(
        { error: `非法 collection/key：${o.collection}/${o.key}`, code: "invalid_key" },
        400,
      );
    }
    if (o.op === "put") {
      let v: string | undefined;
      try {
        v = JSON.stringify(o.value);
      } catch {
        return json({ error: "值无法序列化", code: "invalid_data" }, 400);
      }
      if (v === undefined) {
        return json({ error: "put 缺 value", code: "invalid_request" }, 400);
      }
      const sz = Buffer.byteLength(v);
      if (sz > maxValue) {
        return json({ error: `值过大：${o.key}`, code: "value_too_large" }, 413);
      }
      ops.push({ ...o, valueJson: v, sizeBytes: sz });
    } else {
      ops.push(o);
    }
  }

  for (const op of ops) {
    const policy = getKvPolicy(access.share.id, op.collection);
    const existing = kvGetRecord(access.share.id, op.collection, op.key);
    const allowed = op.op === "put"
      ? canMutateKvPolicy(
          policy,
          "write",
          access.isOwner,
          access.actorKey,
          existing?.creatorKey ?? access.actorKey,
        )
      : canMutateKvPolicy(
          policy,
          "delete",
          access.isOwner,
          access.actorKey,
          existing?.creatorKey ?? null,
        );
    if (!allowed) return forbidden(`没有 ${op.collection}/${op.key} 的操作权限`);
    if (op.op === "put") op.creatorKey = access.actorKey;
  }

  const results = kvBatch(access.share.id, ops);
  return json({ results });
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  if (!isValidOrigin(request)) {
    return json({ error: "非法请求来源", code: "invalid_origin" }, 403);
  }
  const { slug, path } = await ctx.params;
  const access = await resolveAccess(slug, request);
  if ("response" in access) return access.response;

  const parsed = parsePath(path);
  if (!parsed) return notFound();

  const ip = await getClientIp();
  if (!rateLimit(`kv-write:${ip}:${access.share.id}`, 30, 60_000)) {
    return json({ error: "写入过于频繁", code: "rate_limited" }, 429);
  }

  // DELETE /<collection> → clear collection；/<collection>/<key> → 删行
  if (parsed.key === undefined) {
    if (!access.isOwner) {
      return json({ error: "只有分享所有者可以清空 collection", code: "owner_only" }, 403);
    }
    const cleared = kvClearCollection(access.share.id, parsed.collection);
    return json({ cleared });
  }
  const baseVersion = request.nextUrl.searchParams.get("baseVersion");
  const bv = baseVersion !== null ? Number(baseVersion) : undefined;
  const policy = getKvPolicy(access.share.id, parsed.collection);
  const existing = kvGetRecord(access.share.id, parsed.collection, parsed.key);
  if (!canMutateKvPolicy(policy, "delete", access.isOwner, access.actorKey, existing?.creatorKey ?? null)) {
    return forbidden("只有行创建者或 owner 可以删除这行数据");
  }
  const result = kvDelete(access.share.id, parsed.collection, parsed.key, bv);
  if (result.status === "not_found") return notFound();
  if (result.status === "conflict") {
    return json(
      { error: "数据已被修改", code: "version_conflict", item: result.item },
      409,
    );
  }
  return json({ deleted: true });
}
