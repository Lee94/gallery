#!/bin/sh
# 先应用数据库迁移（幂等），再启动 Next standalone server
set -e
node migrate.mjs
exec node server.js
