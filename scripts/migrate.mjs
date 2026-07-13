// 独立于 Next 运行的迁移脚本：本地 `npm run db:migrate`，容器内由 entrypoint 在启动前执行。
// 迁移目录按 cwd 解析（仓库根或容器内 /app 均为 ./drizzle）。
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const dbPath = path.join(dataDir, "gallery.db");
fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
migrate(drizzle(sqlite), { migrationsFolder: path.resolve("drizzle") });
sqlite.close();
console.log(`migrations applied: ${dbPath}`);
