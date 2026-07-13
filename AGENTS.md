<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Gallery — 自托管文件分享平台

上传 HTML/PDF/图片/Markdown 等文件 → 生成 `/s/<slug>` 分享链接（可选密码、过期时间）。多用户，邀请码注册，首个用户自动为 admin。

## 常用命令

- `npm run dev` — 需先 `cp .env.example .env` 并填 `SESSION_SECRET`，再 `npm run db:migrate`
- `npm run db:generate` — 改 `src/db/schema.ts` 后生成迁移 SQL（提交进 git）
- `npm run db:migrate` — 应用迁移（容器 entrypoint 也会执行）
- `npm run lint` / `npx tsc --noEmit`
- `docker compose up -d --build` — 生产部署，数据在 `./data`（SQLite + 上传文件）

## 架构要点

- **访问控制单一入口**：`src/lib/share-access.ts` 的 `resolveShareAccess(slug)`，预览页 `src/app/s/[slug]/page.tsx` 和 raw 端点 `src/app/api/raw/[slug]/route.ts` 共用。不存在/已过期统一 404（防枚举）。
- **密码分享令牌**：HMAC cookie，payload 含 `passwordVersion`；任何密码变更把 version+1 即可让所有已发 cookie 失效（见 `src/actions/shares.ts`）。
- **响应头策略集中在** `src/lib/file-kind.ts`：HTML/SVG 的 CSP `sandbox`（无 `allow-same-origin`）是核心安全边界，配合预览页 iframe 的 sandbox 属性双层隔离——改动前先想清楚。
- **认证**：手写 session（`src/lib/auth/`），cookie 存原始 token，DB 存 SHA-256。变更操作走 Server Actions（内建 CSRF 防护）；upload/raw 是 route handler，upload 手动校验 Origin。
- **存储**：文件存 `$DATA_DIR/files/<nanoid>`（无扩展名，路径不含用户输入）；`better-sqlite3` 同步驱动，事务回调内必须全同步。
- **Next 16**：middleware 叫 `src/proxy.ts`（导出 `proxy`）；`params`/`cookies()`/`headers()` 必须 await。
- **限流**：进程内 Map（`src/lib/rate-limit.ts`），单实例部署前提。

## 注意

- `src/lib/env.ts` 的 `getEnv()` 是惰性的——不要在模块顶层调用，否则构建期会要求环境变量。
- 客户端组件 render 内不要调 `Date.now()`（React Compiler purity 规则会报错），在服务端算好传入。
- React 19 表单 action 完成后会重置未受控输入，出错时要通过 state 回填（见 `AuthFormState`）。
