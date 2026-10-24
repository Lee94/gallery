# Gallery

自托管文件分享平台：上传 HTML / PDF / 图片 / Markdown 等文件，获得一个可直接在浏览器预览的分享链接，可选设置访问密码和过期时间。多用户注册（邀请码制）。

## 功能

- **文件预览**：HTML（沙箱 iframe 隔离）、PDF（浏览器原生）、图片、Markdown（GFM 渲染）、纯文本，其他类型提供下载
- **多文件 Artifact**：支持目录上传、相对资源路径、原链接更新、文本在线编辑、版本快照/预览/回滚
- **共享页面数据**：HTML 可选择启用一份访客共用、可写的 JSON；通过 SDK 保存后，其他打开中的页面通过 SSE 实时收到变更
- **访客私有数据与 KV**：每访客独立 JSON，以及支持 CAS、collection 级 read/write/delete 权限的行级共享数据
- **评论与页面内 LLM**：分享页公开评论、owner 审核；支持流式增量、多轮对话、页面上下文、客户端工具调用、结构化输出、取消/重试和每日 token 配额
- **Artifact 管理台**：`/dashboard/<slug>` 集中管理文件、版本、数据、评论、访问控制和 LLM 配置；owner 可让 AI 读取当前源码、回答问题或直接修改文件并生成版本
- **React Artifact**：上传 JSX/TSX 入口后在服务端以固定 React 版本构建，支持相对导入和 CSS；依赖白名单、内容寻址构建缓存和页面内错误展示
- **访客附件**：页面可上传、列出、下载和删除附件；支持私有/共享可见性及单文件、分享、访客三级配额
- **展示与再创作**：自定义标题、描述、图标、封面和 OG 信息；全屏/嵌入、ZIP 导出、源码浏览、Fork/Remix、固定与手动排序
- **分享链接**：不可枚举的随机短链 `/s/<slug>`，任何人可直接打开
- **访问密码**：每个分享可单独设置/修改/移除密码，改密码后已发放的访问凭证立即失效
- **过期时间**：可设置分享自动过期
- **多用户**：邮箱+密码注册；第一个注册的用户自动成为管理员，之后需要管理员生成的邀请码（一码一用）
- **安全**：用户上传的 HTML 在 opaque origin 中运行（CSP sandbox + iframe sandbox 双层隔离），读不到主站的登录态；argon2id 密码哈希；登录/注册/密码尝试限流

## Artifact 与页面 SDK

上传 HTML 时可启用所需能力，也可在 `/dashboard/<slug>` 管理台稍后开启。共享页面数据默认可由所有访客读写；KV 可按 collection 设置仅 owner、所有访客或行创建者权限。有访问密码时需先解锁。这些能力适用于协作页面和小型应用，不应把公开分享当作机密存储。

页面引入 `/sdk/page-state-v1.js`，统一从 `window.Gallery` 访问能力。旧的 `GalleryPageState` / `GalleryVisitorState` / `GalleryDB` / `GalleryLLM` 全局变量继续兼容：

```html
<script src="/sdk/page-state-v1.js"></script>
<script>
  (async () => {
    const capabilities = await Gallery.getCapabilities();
    if (!capabilities.pageState) throw new Error("共享页面数据未启用");

    const store = Gallery.pageState.connect();
    const snapshot = await store.get();

    const todo = { id: crypto.randomUUID(), text: "买牛奶", done: false };
    const saved = await store.update((data) => ({
      todos: [...(data?.todos ?? []), todo],
    }));
    console.log(saved.version);
  })();
</script>
```

SDK 能力：

- `Gallery.pageState.connect()`：整页共享 JSON 的 `get / save / update`。
- `Gallery.visitorState.connect()`：当前访客私有 JSON 的 `get / save / update`。
- `Gallery.db.collection(name)`：KV 行的 `get / list / put / update / del`。
- `Gallery.llm.chat(options)`：多轮 `messages` / `prompt`、页面 `context`、流式 `onDelta`、`responseSchema`、客户端 `tools`、`AbortSignal` 取消和有限重试；工具结果会自动回填后继续对话。
- `Gallery.llm.ask(prompt, { context? })`：保留的单次文本调用兼容接口。
- `Gallery.files.list/upload/download/delete`：管理当前 Artifact 的访客附件；`private` 仅上传者和 owner 可读，`shared` 可由有分享访问权的人读取。
- `Gallery.getCapabilities()`：查询能力、协议版本、`dataGeneration` 和 `dataSchemaVersion`。
- `Gallery.requireDataSchema(version)`：声明页面所需数据结构版本；后续数据请求如不匹配会返回 409。
- `Gallery.events.subscribe(listener, { types? })`：订阅 `page-state / kv / comments / version / attachments` 变更提示，返回取消订阅函数。事件不携带数据正文，收到后调用对应 API 重新读取。

`Gallery.llm.chat` 的工具定义包含 `name / description / parameters / execute(args, context)`。纯文本调用使用 NDJSON 流式下发；工具或 JSON Schema 调用自动使用非流式上游以保证结果完整。工具循环最多 6 轮，重试最多 3 次且只针对可恢复的上游错误。是否可用以 `getCapabilities()` 为准。

类型声明位于 `/sdk/page-state-v1.d.ts`。所有能力只在 `/s/<slug>` 预览页生效，直接打开 raw 文件或历史版本不会连接当前数据。

- 数据只保存在服务端，不是 `localStorage`；访客私有数据的匿名设备标识由父页面保存，子页面无法读取。
- 实时同步使用 `/api/events/<slug>` 的 SSE；支持 `Last-Event-ID` 重放、断线 `reset` 和 heartbeat。事件总线与限流均为进程内实现，当前仅支持单实例部署。
- 每个分享只保留最新页面 JSON，默认最大 256KB；带 `baseVersion` 的条件写入避免静默覆盖。
- `dataGeneration` 标识数据空间；管理台“新建数据空间”会清空页面、访客和 KV 数据并递增它，旧页面写入会被拒绝。`dataSchemaVersion` 用于页面声明数据结构兼容版本。
- KV 清空整个 collection 仅 owner 可执行；read 支持 all/owner，write/delete 还支持 creator（行创建者）。登录用户的私有数据和创建者身份跨设备一致，匿名用户使用随机 visitor key。
- 管理台可以停用（保留数据）或清空数据。删除分享会级联删除数据。
- 附件存于 `$DATA_DIR/attachments/<nanoid>`，文件名不进入存储路径；下载强制作为附件并带 `nosniff`。私有附件越权统一返回 404。
- React 运行时固定为 `19.3.1`，只允许 `react`、`react-dom`、`react-dom/client` 和 JSX runtime 白名单导入，不联网安装依赖。缓存键包含源码、入口、React 和构建器版本。
- 每个分享最多 2 个活动 LLM 调用、每个访客最多 1 个；调用前预留输出 token，取消/中断也记录部分用量。事件、并发预留和限流均为进程内状态，当前仅支持单实例部署。
- 管理台“AI”助手仅 owner 可用，可读取当前文本源码；修改最多 10 个文件、单文件 512KB、总计 2MB，校验通过后写入并生成版本。对话仅保存在当前浏览器，不写服务端历史。
- 分享页的 `?embed=1` 用于嵌入，`?source=1` 用于源码浏览；ZIP 导出和 Fork 复用同一分享访问控制。Fork 只复制当前公开文件与能力配置，不复制数据、附件、评论、密码或历史版本。
- 可直接上传 `examples/shared-todolist.html` 体验。

## 部署（Docker）

```bash
cp .env.example .env
# 编辑 .env：至少填上 SESSION_SECRET（openssl rand -base64 48）和对外的 APP_URL
docker compose up -d --build
```

数据（SQLite 数据库 + 上传的文件）都在 `./data` 目录，备份该目录即可。

> 网络受限（无法访问 GitHub / Debian 官方源）时，在 `.env` 里加一行 `DEBIAN_MIRROR=mirrors.ustc.edu.cn` 再构建；基础镜像拉不动可先 `docker pull docker.m.daocloud.io/library/node:24-bookworm-slim && docker tag docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim`。

### 用预构建镜像部署（免本地构建）

每次推送 `master` 会自动构建并发布 `edge` 镜像，打 `v*` tag 会发布对应版本号和 `latest`（见 `.github/workflows/docker-publish.yml`，支持 amd64 / arm64）。直接拉取即可，无需在服务器上构建：

```bash
docker pull ghcr.io/lee94/gallery:latest
```

把 `docker-compose.yml` 里的 `build:` 段换成 `image:` 即可用现成镜像：

```yaml
services:
  gallery:
    image: ghcr.io/lee94/gallery:latest
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      DATA_DIR: /data
    volumes:
      - ./data:/data
    restart: unless-stopped
```

首次打开 `http://<你的域名>:3000/register` 注册的用户即管理员，之后在「邀请码」页面生成邀请码给其他用户。

### 反向代理

生产环境建议前置 nginx/Caddy 做 HTTPS。注意：

- nginx 默认 `client_max_body_size` 只有 1MB，需调大（如 `client_max_body_size 64m;`），否则上传会 413
- 设置 `.env` 中 `TRUST_PROXY=1`，限流才能拿到真实来源 IP
- `APP_URL` 填对外的完整地址（如 `https://share.example.com`），分享链接和上传/共享数据写入接口的 Origin 校验都依赖它

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_SECRET` | 必填 | ≥32 字符，会话与分享访问令牌的签名密钥 |
| `APP_URL` | `http://localhost:3000` | 站点对外地址 |
| `DATA_DIR` | `./data`（容器内 `/data`） | 数据根目录 |
| `MAX_FILE_SIZE_MB` | `50` | 上传大小上限 |
| `MAX_PAGE_STATE_SIZE_KB` | `256` | 每个分享的共享 JSON 大小上限 |
| `ATTACHMENT_MAX_FILE_MB` | `10` | 单个访客附件大小上限 |
| `ATTACHMENT_MAX_SHARE_MB` | `100` | 每个分享的附件总配额 |
| `ATTACHMENT_MAX_VISITOR_MB` | `20` | 每个访客在单个分享内的附件配额 |
| `TRUST_PROXY` | `0` | 反代后置 `1`，信任 `x-forwarded-for` |
| `LLM_BASE_URL` | 无 | 可选，OpenAI 兼容服务地址；与 `LLM_API_KEY` 同时配置才启用 |
| `LLM_API_KEY` | 无 | 可选，仅服务端持有，不下发给 Artifact |
| `LLM_DEFAULT_MODEL` | `deepseek-chat` | 页面 LLM 默认模型，可按分享覆盖 |
| `LLM_MAX_TOKENS` | `1024` | 单次上游调用的最大输出 token |
| `LLM_DEFAULT_DAILY_BUDGET` | `50000` | 每个分享默认 24 小时 token 配额 |

## 本地开发

```bash
pnpm install
cp .env.example .env   # 填 SESSION_SECRET
pnpm run db:migrate    # 初始化/更新数据库
pnpm run test          # Node 集成测试 + SDK 协议测试
pnpm run dev
```

改动 `src/db/schema.ts` 后执行 `pnpm run db:generate` 生成迁移，再 `pnpm run db:migrate` 应用。

## 技术栈

Next.js 16（App Router）· SQLite（better-sqlite3 + Drizzle ORM）· Tailwind CSS 4 · @node-rs/argon2
