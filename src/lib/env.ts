import path from "node:path";
import { z } from "zod";

const schema = z.object({
  DATA_DIR: z.string().default("./data"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET 至少需要 32 个字符（可用 `openssl rand -base64 48` 生成）"),
  MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(50),
  APP_URL: z.url().default("http://localhost:3000"),
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
});

export interface Env {
  dataDir: string;
  filesDir: string;
  tmpDir: string;
  databasePath: string;
  sessionSecret: string;
  maxFileSizeBytes: number;
  appUrl: string;
  trustProxy: boolean;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`环境变量校验失败：\n${z.prettifyError(parsed.error)}`);
    }
    const dataDir = path.resolve(parsed.data.DATA_DIR);
    cached = {
      dataDir,
      filesDir: path.join(dataDir, "files"),
      tmpDir: path.join(dataDir, "tmp"),
      databasePath: path.join(dataDir, "gallery.db"),
      sessionSecret: parsed.data.SESSION_SECRET,
      maxFileSizeBytes: parsed.data.MAX_FILE_SIZE_MB * 1024 * 1024,
      appUrl: parsed.data.APP_URL.replace(/\/$/, ""),
      trustProxy: parsed.data.TRUST_PROXY === "1",
    };
  }
  return cached;
}

/** 文件超限的统一提示文案（upload route 与 MCP 工具共用，避免多处硬编码换算） */
export function fileTooLargeMessage(): string {
  return `文件超过大小限制（${getEnv().maxFileSizeBytes / 1024 / 1024}MB）`;
}
