// 独立于 Next 运行的迁移脚本：本地 `npm run db:migrate`，容器内由 entrypoint 在启动前执行。
// 迁移目录按 cwd 解析（仓库根或容器内 /app 均为 ./drizzle）。
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const dbPath = path.join(dataDir, "gallery.db");
const filesDir = path.join(dataDir, "files");
fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
migrate(drizzle(sqlite), { migrationsFolder: path.resolve("drizzle") });

// 文件布局迁移：把 files/<shareId> 单文件改成 files/<shareId>/index.html。
// 只在 share_files 表存在、且该 shareId 是「文件而非目录」时执行——幂等。
const hasShareFiles = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='share_files'")
  .get();
if (hasShareFiles && fs.existsSync(filesDir)) {
  const moved = [];
  for (const name of fs.readdirSync(filesDir)) {
    const p = path.join(filesDir, name);
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue; // 已是目录（新布局）或非常规文件
      // shareId 是 nanoid(16)，排除 .tmp 等杂项
      if (!/^[A-Za-z0-9_-]{16}$/.test(name)) continue;
      const dir = path.join(filesDir, name);
      // 先挪到临时文件，mkdir，再挪进目录——避免 rename 目标冲突
      const tmp = path.join(filesDir, `${name}.migrating`);
      fs.renameSync(p, tmp);
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(tmp, path.join(dir, "index.html"));
      moved.push(name);
    } catch (e) {
      console.error(`migrate file layout ${name}:`, e);
    }
  }
  if (moved.length) {
    console.log(`migrated file layout: ${moved.length} share(s)`);
  }
}

sqlite.close();
console.log(`migrations applied: ${dbPath}`);
