<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gallery — 自托管文件分享平台

上传 HTML/PDF/图片/Markdown 等文件 → 生成 `/s/<slug>` 分享链接（可选密码、过期时间）。多用户，邀请码注册，首个用户自动为 admin。

## 常用命令

- 包管理器用 pnpm（版本固定在 `package.json` 的 `packageManager` 字段）
- `pnpm run dev` — 需先 `cp .env.example .env` 并填 `SESSION_SECRET`，再 `pnpm run db:migrate`
- `pnpm run db:generate` — 改 `src/db/schema.ts` 后生成迁移 SQL（提交进 git）
- `pnpm run db:migrate` — 应用迁移（容器 entrypoint 也会执行）
- `pnpm run lint` / `pnpm exec tsc --noEmit`
- `docker compose up -d --build` — 生产部署，数据在 `./data`（SQLite + 上传文件）

## 架构要点

- **访问控制单一入口**：`src/lib/share-access.ts` 的 `resolveShareAccess(slug)`，预览页 `src/app/s/[slug]/page.tsx` 和 raw 端点 `src/app/api/raw/[slug]/route.ts` 共用。不存在/已过期统一 404（防枚举）。
- **密码分享令牌**：HMAC cookie，payload 含 `passwordVersion`；任何密码变更把 version+1 即可让所有已发 cookie 失效（见 `src/actions/shares.ts`）。
- **响应头策略集中在** `src/lib/file-kind.ts`：HTML/SVG 的 CSP `sandbox`（无 `allow-same-origin`）是核心安全边界，配合预览页 iframe 的 sandbox 属性双层隔离——改动前先想清楚。
- **共享页面数据**：HTML 可通过 `shares.pageStateEnabled` 显式开启一份所有访客共用、可写的 JSON，存 `share_page_states`（仅最新快照，`baseVersion` + 条件 UPDATE 做 CAS）。`/api/page-state/[slug]` 必须继续复用 `resolveShareAccess`、显式 `no-store`、限制大小和匿名写频率。沙箱 HTML 通过 `PageStateHtmlViewer` 的 postMessage/MessageChannel 桥接访问，slug 由父页面固定；不要为了存储开放 `allow-same-origin`、CORS 或向子页面注入 cookie。页面 SDK 是 `public/sdk/page-state-v1.js`，其他访客刷新后看到修改。
- **认证**：手写 session（`src/lib/auth/`），cookie 存原始 token，DB 存 SHA-256。变更操作走 Server Actions（内建 CSRF 防护）；upload/raw 是 route handler，upload 和共享数据写入手动校验 Origin。
- **MCP 服务**：`src/app/api/mcp/route.ts` 是手写的无状态 MCP（Streamable HTTP / JSON-RPC 2.0）端点，供 AI agent 上传/管理文件。认证走 `Authorization: Bearer`（`api_tokens` 表，与 session 同构：DB 存 SHA-256，见 `src/lib/auth/api-token.ts`），故不校验 Origin。协议分发在 `src/lib/mcp/server.ts`，工具在 `src/lib/mcp/tools.ts`（zod 校验 + `z.toJSONSchema` 派生）。上传/管理的业务逻辑抽在 `src/lib/shares/{create,manage}.ts`，与浏览器端 upload route、`src/actions/shares.ts` 共用。用户在 `/settings/tokens` 管理令牌。
- **存储**：文件存 `$DATA_DIR/files/<nanoid>`（无扩展名，路径不含用户输入）；`better-sqlite3` 同步驱动，事务回调内必须全同步。
- **Next 16**：middleware 叫 `src/proxy.ts`（导出 `proxy`）；`params`/`cookies()`/`headers()` 必须 await。
- **限流**：进程内 Map（`src/lib/rate-limit.ts`），单实例部署前提。

## 注意

- `src/lib/env.ts` 的 `getEnv()` 是惰性的——不要在模块顶层调用，否则构建期会要求环境变量。
- 客户端组件 render 内不要调 `Date.now()`（React Compiler purity 规则会报错），在服务端算好传入。
- React 19 表单 action 完成后会重置未受控输入，出错时要通过 state 回填（见 `AuthFormState`）。
