import {
  index,
  integer,
  sqliteTable,
  text,
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
    id: text("id").primaryKey(), // nanoid(16)，同时是磁盘文件名
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(), // 分享链接路径 /s/<slug>
    originalName: text("original_name").notNull(), // 仅存 DB，不参与磁盘路径
    mimeType: text("mime_type").notNull(), // 服务端按扩展名白名单推导
    size: integer("size").notNull(),
    kind: text("kind", { enum: SHARE_KINDS }).notNull(),
    passwordHash: text("password_hash"), // NULL = 公开
    // 每次设置/修改/移除密码 +1，使已签发的访问 cookie 立即失效
    passwordVersion: integer("password_version").notNull().default(0),
    expiresAt: integer("expires_at"), // NULL = 永不过期
    // 仅 HTML 可开启；开启后所有能访问分享的访客共用一份可写 JSON 数据
    pageStateEnabled: integer("page_state_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("shares_owner_id_idx").on(t.ownerId)],
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

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type SharePageState = typeof sharePageStates.$inferSelect;
