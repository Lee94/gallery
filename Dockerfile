# glibc 镜像：better-sqlite3 / @node-rs/argon2 均有 linux-gnu 预编译产物，避开 musl 编译
# pnpm 版本由 package.json 的 packageManager 字段固定，corepack 按其安装
FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# 网络受限环境可换 Debian 源，如 --build-arg DEBIAN_MIRROR=mirrors.ustc.edu.cn
ARG DEBIAN_MIRROR=deb.debian.org
# better-sqlite3 预编译产物下载不到（网络受限）时会回退源码编译，需要 python3/make/g++；
# 只影响 deps 构建阶段，不进入最终镜像
RUN sed -i "s/deb.debian.org/${DEBIAN_MIRROR}/g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# pnpm 的 node_modules 里包目录是指向 .pnpm 的符号链接，先解引用成实目录供 runner 拷贝
RUN cp -RL node_modules/drizzle-orm /opt/drizzle-orm

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# standalone 只追踪应用 import 过的文件，migrate.mjs 用到的 migrator 不在其中，需完整拷贝
COPY --from=deps /opt/drizzle-orm ./node_modules/drizzle-orm
COPY drizzle ./drizzle
COPY scripts/migrate.mjs ./migrate.mjs
COPY docker-entrypoint.sh ./
# 不声明 USER：entrypoint 以 root 启动，修正 bind mount 的 /data 属主后降权到 node
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
