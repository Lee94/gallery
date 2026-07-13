#!/bin/sh
# 以 root 启动时先修正 /data 属主（bind mount 的宿主机目录常归 root，
# 否则 SQLite 报 SQLITE_CANTOPEN），再用 setpriv 降权到 node 重新执行自身；
# 降权后应用数据库迁移（幂等），启动 Next standalone server
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
    # 顶层属主不对才递归 chown，避免每次启动都遍历全部上传文件
    [ "$(stat -c %u "$DATA_DIR")" = "$(id -u node)" ] || chown -R node:node "$DATA_DIR"
    exec setpriv --reuid node --regid node --init-groups "$0" "$@"
fi

node migrate.mjs
exec node server.js
