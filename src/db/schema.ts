import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// 所有时间戳均为 unix 毫秒

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // nanoid(16)
  email: text("email").notNull().unique(), // 存储前 lowercase + trim
  passwordHash: text("password_hash").notNull(), // argon2id
  role: text("role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    // SHA-256(token) 的 hex；原始 token 只存在用户 cookie 里
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

// MCP / 程序化访问用的 Bearer 令牌。id = SHA-256(token) 的 hex，原始 token 只在创建时返回一次
// （与 sessions 同构：DB 泄露不等于令牌泄露）。归属到某个用户，agent 只能操作该用户自己的分享。
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(), // SHA-256(token) 的 hex
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // 用户可读标签，便于区分/吊销
    lastUsedAt: integer("last_used_at"), // 最近一次调用时间，NULL = 从未使用
    expiresAt: integer("expires_at"), // NULL = 永不过期
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("api_tokens_user_id_idx").on(t.userId)],
);

export const inviteCodes = sqliteTable(
  "invite_codes",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(), // 一次性，已用即失效
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    usedBy: text("used_by").references(() => users.id),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("invite_codes_created_by_idx").on(t.createdBy)],
);

export const SHARE_KINDS = [
  "html",
  "pdf",
  "image",
  "markdown",
  "text",
  "other",
] as const;

export type ShareKind = (typeof SHARE_KINDS)[number];

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(), // nanoid(16)，同时是磁盘目录名（files/<id>/）
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(), // 分享链接路径 /s/<slug>
    originalName: text("original_name").notNull(), // 仅存 DB，不参与磁盘路径
    title: text("title"),
    description: text("description").notNull().default(""),
    icon: text("icon").notNull().default(""),
    coverPath: text("cover_path"),
    sourceEnabled: integer("source_enabled", { mode: "boolean" }).notNull().default(true),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    forkedFromSlug: text("forked_from_slug"),
    mimeType: text("mime_type").notNull(), // 服务端按扩展名白名单推导（入口文件类型）
    size: integer("size").notNull(), // 入口文件大小，用于展示
    kind: text("kind", { enum: SHARE_KINDS }).notNull(),
    runtime: text("runtime", { enum: ["static", "react"] }).notNull().default("static"),
    runtimeVersion: text("runtime_version").notNull().default("19.3.1"),
    // 入口文件相对路径（files/<id>/<entryPath>），默认 index.html；单文件 share 也是它
    entryPath: text("entry_path").notNull().default("index.html"),
    passwordHash: text("password_hash"), // NULL = 公开
    // 每次设置/修改/移除密码 +1，使已签发的访问 cookie 立即失效
    passwordVersion: integer("password_version").notNull().default(0),
    expiresAt: integer("expires_at"), // NULL = 永不过期
    // 仅 HTML 可开启；开启后所有能访问分享的访客共用一份可写 JSON 数据
    pageStateEnabled: integer("page_state_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    // 仅 HTML 可开启；开启后每个访客有独立的可写 JSON 数据（visitorKey 隔离）
    visitorStateEnabled: integer("visitor_state_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    // 行级共享数据（share_kv 表）：collection + key 的行集，访客都可读写
    kvEnabled: integer("kv_enabled", { mode: "boolean" }).notNull().default(false),
    // 访客附件：上传者私有或分享内共享；通过父页面桥接访问，不向沙箱暴露存储路径。
    attachmentsEnabled: integer("attachments_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    // 内容版本与数据版本分离；dataGeneration 用于发布时切到全新的数据空间。
    dataGeneration: integer("data_generation").notNull().default(1),
    dataSchemaVersion: integer("data_schema_version").notNull().default(1),
    // 访客评论：/s/<slug> 面板里的公开讨论
    commentsEnabled: integer("comments_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    commentsVisitorWrite: integer("comments_visitor_write", { mode: "boolean" })
      .notNull()
      .default(true),
    // 页面内 LLM：子页面可经桥接调服务端配置的 LLM；按日 token 预算限流
    llmEnabled: integer("llm_enabled", { mode: "boolean" }).notNull().default(false),
    llmDailyTokenBudget: integer("llm_daily_token_budget"), // NULL = 用全局默认
    llmModel: text("llm_model"), // NULL = 用 LLM_DEFAULT_MODEL
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("shares_owner_id_idx").on(t.ownerId)],
);

// 分享的文件清单：磁盘上 files/<shareId>/<path> 一一对应。
// 单文件分享只有一行（path = shares.entryPath）；多文件 artifact 一个 share 挂多个 path。
// path 是相对路径，禁止 .. / 绝对路径 / 反斜杠；由服务端校验后落盘。
export const shareFiles = sqliteTable(
  "share_files",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    path: text("path").notNull(), // 相对路径，如 "index.html" / "js/app.js"
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.path] })],
);

// 可存储 HTML 的共享数据：只保留最新 JSON 快照，version 用于乐观并发控制。
// 启用分享时即创建行，避免首次写入的 insert 竞争；停用仅关闭访问，保留此行。
export const sharePageStates = sqliteTable("share_page_states", {
  shareId: text("share_id")
    .primaryKey()
    .references(() => shares.id, { onDelete: "cascade" }),
  dataJson: text("data_json").notNull().default("null"),
  version: integer("version").notNull().default(0),
  sizeBytes: integer("size_bytes").notNull().default(4), // "null" 的 UTF-8 字节数
  updatedAt: integer("updated_at").notNull(),
});

// 访客私有数据：每个 (shareId, visitorKey) 一份独立 JSON 快照。
// visitorKey 由父页面为每个访客生成并存 localStorage，子页面通过 postMessage 桥接访问；
// 子页面永远拿不到 key 本身，无法冒充其他访客。
export const shareVisitorStates = sqliteTable(
  "share_visitor_states",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    visitorKey: text("visitor_key").notNull(),
    dataJson: text("data_json").notNull().default("null"),
    version: integer("version").notNull().default(0),
    sizeBytes: integer("size_bytes").notNull().default(4),
    updatedAt: integer("updated_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shareId, t.visitorKey] }),
    index("share_visitor_states_share_id_idx").on(t.shareId),
  ],
);

// 行级共享数据：share_kv(shareId, collection, key) → JSON 值 + 行级 CAS version。
// 与 share_page_states 的差别：page-state 是「整页一份 JSON」，写冲突粒度是整个文档；
// kv 是「collection 里的多行」，写冲突粒度是单行——适合投票、留言、排行榜这类并行写。
export const shareKv = sqliteTable(
  "share_kv",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    // user:<id> 或匿名 visitorKey；仅用于 creator 权限校验，不出现在公开 API 响应中。
    creatorKey: text("creator_key"),
    version: integer("version").notNull().default(1), // 行内 CAS
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shareId, t.collection, t.key] }),
    index("share_kv_share_coll_idx").on(t.shareId, t.collection),
  ],
);

export const KV_ACCESS_MODES = ["all", "owner", "creator"] as const;
export type KvAccessMode = (typeof KV_ACCESS_MODES)[number];

// collection 级 ACL。creator：任何人都可新建，但只有创建者可覆盖/删除自己的行。
// 没有策略行时保持 all/all/all，兼容已有分享。
export const shareKvPolicies = sqliteTable(
  "share_kv_policies",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    readMode: text("read_mode", { enum: KV_ACCESS_MODES }).notNull().default("all"),
    writeMode: text("write_mode", { enum: KV_ACCESS_MODES }).notNull().default("all"),
    deleteMode: text("delete_mode", { enum: KV_ACCESS_MODES }).notNull().default("all"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.collection] })],
);

export const ATTACHMENT_VISIBILITIES = ["private", "shared"] as const;
export type AttachmentVisibility = (typeof ATTACHMENT_VISIBILITIES)[number];

export const shareAttachments = sqliteTable(
  "share_attachments",
  {
    id: text("id").primaryKey(), // nanoid；同时是 attachments/<id> 的服务端存储名
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    creatorKey: text("creator_key").notNull(), // user:<id> 或匿名 visitor key；不下发客户端
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    visibility: text("visibility", { enum: ATTACHMENT_VISIBILITIES })
      .notNull()
      .default("private"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("share_attachments_share_idx").on(t.shareId),
    index("share_attachments_creator_idx").on(t.shareId, t.creatorKey),
  ],
);

// 内容寻址 blob：版本历史只存 manifest，文件内容按 sha256 去重落在 data/blobs/。
export const shareBlobs = sqliteTable("share_blobs", {
  sha256: text("sha256").primaryKey(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: integer("created_at").notNull(),
});

// 版本历史：每次 share 文件变更（update/upload/delete file）物化一条 manifest。
// manifest 是 JSON 数组 [{path, sha256, sizeBytes, mimeType}]，按 share 单调递增 versionNo。
export const shareVersions = sqliteTable(
  "share_versions",
  {
    id: text("id").primaryKey(), // nanoid(16)
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(), // 每 share 从 1 递增
    label: text("label"), // 可选发布标签
    manifest: text("manifest").notNull(), // JSON: [{path, sha256, sizeBytes, mimeType}]
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("share_versions_share_version_uniq").on(t.shareId, t.versionNo),
  ],
);

// 评论：share 面板里的公开讨论。visitorKey 标识访客作者（可空——owner 评论不带）。
// owner 评论打 isOwner 标记；status: open / resolved / hidden。
export const shareComments = sqliteTable(
  "share_comments",
  {
    id: text("id").primaryKey(),
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    visitorKey: text("visitor_key"),
    authorLabel: text("author_label").notNull().default("访客"),
    body: text("body").notNull(),
    isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["open", "resolved", "hidden"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("share_comments_share_idx").on(t.shareId, t.createdAt)],
);

// owner 屏蔽特定访客的评论权限
export const shareCommentBans = sqliteTable(
  "share_comment_bans",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    visitorKey: text("visitor_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.visitorKey] })],
);

// LLM 用量：每次桥接调用记一行，按 shareId+createdAt 做日额度累计
export const shareLlmUsage = sqliteTable(
  "share_llm_usage",
  {
    id: text("id").primaryKey(),
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    visitorKey: text("visitor_key"),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("share_llm_usage_share_idx").on(t.shareId, t.createdAt),
    index("share_llm_usage_visitor_idx").on(t.visitorKey, t.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type ShareFile = typeof shareFiles.$inferSelect;
export type SharePageState = typeof sharePageStates.$inferSelect;
export type ShareVisitorState = typeof shareVisitorStates.$inferSelect;
export type ShareKv = typeof shareKv.$inferSelect;
export type ShareKvPolicy = typeof shareKvPolicies.$inferSelect;
export type ShareAttachment = typeof shareAttachments.$inferSelect;
export type ShareBlob = typeof shareBlobs.$inferSelect;
export type ShareVersion = typeof shareVersions.$inferSelect;
export type ShareComment = typeof shareComments.$inferSelect;
export type ShareCommentBan = typeof shareCommentBans.$inferSelect;
export type ShareLlmUsage = typeof shareLlmUsage.$inferSelect;
