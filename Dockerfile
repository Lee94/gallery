# glibc 镜像：better-sqlite3 / @node-rs/argon2 均有 linux-gnu 预编译产物，避开 musl 编译
# 用 node:24（npm 11）与本地开发及 package-lock.json 的生成环境保持一致
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# 网络受限环境可换 Debian 源，如 --build-arg DEBIAN_MIRROR=mirrors.ustc.edu.cn
ARG DEBIAN_MIRROR=deb.debian.org
# better-sqlite3 预编译产物下载不到（网络受限）时会回退源码编译，需要 python3/make/g++；
# 只影响 deps 构建阶段，不进入最终镜像
RUN sed -i "s/deb.debian.org/${DEBIAN_MIRROR}/g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

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
COPY --from=deps /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY drizzle ./drizzle
COPY scripts/migrate.mjs ./migrate.mjs
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
