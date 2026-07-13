# Gallery

自托管文件分享平台：上传 HTML / PDF / 图片 / Markdown 等文件，获得一个可直接在浏览器预览的分享链接，可选设置访问密码和过期时间。多用户注册（邀请码制）。

## 功能

- **文件预览**：HTML（沙箱 iframe 隔离）、PDF（浏览器原生）、图片、Markdown（GFM 渲染）、纯文本，其他类型提供下载
- **分享链接**：不可枚举的随机短链 `/s/<slug>`，任何人可直接打开
- **访问密码**：每个分享可单独设置/修改/移除密码，改密码后已发放的访问凭证立即失效
- **过期时间**：可设置分享自动过期
- **多用户**：邮箱+密码注册；第一个注册的用户自动成为管理员，之后需要管理员生成的邀请码（一码一用）
- **安全**：用户上传的 HTML 在 opaque origin 中运行（CSP sandbox + iframe sandbox 双层隔离），读不到主站的登录态；argon2id 密码哈希；登录/注册/密码尝试限流

## 部署（Docker）

```bash
cp .env.example .env
# 编辑 .env：至少填上 SESSION_SECRET（openssl rand -base64 48）和对外的 APP_URL
docker compose up -d --build
```

数据（SQLite 数据库 + 上传的文件）都在 `./data` 目录，备份该目录即可。

> 网络受限（无法访问 GitHub / Debian 官方源）时，在 `.env` 里加一行 `DEBIAN_MIRROR=mirrors.ustc.edu.cn` 再构建；基础镜像拉不动可先 `docker pull docker.m.daocloud.io/library/node:22-bookworm-slim && docker tag docker.m.daocloud.io/library/node:22-bookworm-slim node:22-bookworm-slim`。

首次打开 `http://<你的域名>:3000/register` 注册的用户即管理员，之后在「邀请码」页面生成邀请码给其他用户。

### 反向代理

生产环境建议前置 nginx/Caddy 做 HTTPS。注意：

- nginx 默认 `client_max_body_size` 只有 1MB，需调大（如 `client_max_body_size 64m;`），否则上传会 413
- 设置 `.env` 中 `TRUST_PROXY=1`，限流才能拿到真实来源 IP
- `APP_URL` 填对外的完整地址（如 `https://share.example.com`），分享链接和上传接口的 Origin 校验都依赖它

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_SECRET` | 必填 | ≥32 字符，会话与分享访问令牌的签名密钥 |
| `APP_URL` | `http://localhost:3000` | 站点对外地址 |
| `DATA_DIR` | `./data`（容器内 `/data`） | 数据根目录 |
| `MAX_FILE_SIZE_MB` | `50` | 上传大小上限 |
| `TRUST_PROXY` | `0` | 反代后置 `1`，信任 `x-forwarded-for` |

## 本地开发

```bash
npm install
cp .env.example .env   # 填 SESSION_SECRET
npm run db:migrate     # 初始化/更新数据库
npm run dev
```

改动 `src/db/schema.ts` 后执行 `npm run db:generate` 生成迁移，再 `npm run db:migrate` 应用。

## 技术栈

Next.js 16（App Router）· SQLite（better-sqlite3 + Drizzle ORM）· Tailwind CSS 4 · @node-rs/argon2
