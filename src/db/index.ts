import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

function createDb() {
  const env = getEnv();
  fs.mkdirSync(path.dirname(env.databasePath), { recursive: true });
  const sqlite = new Database(env.databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

// globalThis 缓存：dev 热重载时避免重复打开数据库；惰性创建避免构建期触碰数据目录
const globalForDb = globalThis as unknown as { __galleryDb?: Db };

export function getDb(): Db {
  return (globalForDb.__galleryDb ??= createDb());
}
