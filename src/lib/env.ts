import path from "node:path";
import { z } from "zod";

const schema = z.object({
  DATA_DIR: z.string().default("./data"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET 至少需要 32 个字符（可用 `openssl rand -base64 48` 生成）"),
  MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(50),
  MAX_PAGE_STATE_SIZE_KB: z.coerce.number().int().positive().default(256),
  ATTACHMENT_MAX_FILE_MB: z.coerce.number().int().positive().default(10),
  ATTACHMENT_MAX_SHARE_MB: z.coerce.number().int().positive().default(100),
  ATTACHMENT_MAX_VISITOR_MB: z.coerce.number().int().positive().default(20),
  APP_URL: z.url().default("http://localhost:3000"),
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
  // 页面内 LLM：OpenAI 兼容上游（DeepSeek / OpenAI / 任何 /v1/chat/completions 实现）
  LLM_BASE_URL: z.url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_DEFAULT_MODEL: z.string().default("deepseek-chat"),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  LLM_DEFAULT_DAILY_BUDGET: z.coerce.number().int().positive().default(50_000),
});

export interface Env {
  dataDir: string;
  filesDir: string;
  tmpDir: string;
  attachmentsDir: string;
  databasePath: string;
  sessionSecret: string;
  maxFileSizeBytes: number;
  maxPageStateSizeBytes: number;
  attachmentLimits: { fileBytes: number; shareBytes: number; visitorBytes: number };
  appUrl: string;
  /** cookie 的 Secure 标志跟随 APP_URL 协议：http 部署时浏览器会拒存 Secure cookie */
  cookieSecure: boolean;
  trustProxy: boolean;
  llm?: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    maxTokens: number;
    defaultDailyBudget: number;
  };
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
      attachmentsDir: path.join(dataDir, "attachments"),
      databasePath: path.join(dataDir, "gallery.db"),
      sessionSecret: parsed.data.SESSION_SECRET,
      maxFileSizeBytes: parsed.data.MAX_FILE_SIZE_MB * 1024 * 1024,
      maxPageStateSizeBytes: parsed.data.MAX_PAGE_STATE_SIZE_KB * 1024,
      attachmentLimits: {
        fileBytes: parsed.data.ATTACHMENT_MAX_FILE_MB * 1024 * 1024,
        shareBytes: parsed.data.ATTACHMENT_MAX_SHARE_MB * 1024 * 1024,
        visitorBytes: parsed.data.ATTACHMENT_MAX_VISITOR_MB * 1024 * 1024,
      },
      appUrl: parsed.data.APP_URL.replace(/\/$/, ""),
      cookieSecure: new URL(parsed.data.APP_URL).protocol === "https:",
      trustProxy: parsed.data.TRUST_PROXY === "1",
      llm:
        parsed.data.LLM_BASE_URL && parsed.data.LLM_API_KEY
          ? {
              baseUrl: parsed.data.LLM_BASE_URL.replace(/\/$/, ""),
              apiKey: parsed.data.LLM_API_KEY,
              defaultModel: parsed.data.LLM_DEFAULT_MODEL,
              maxTokens: parsed.data.LLM_MAX_TOKENS,
              defaultDailyBudget: parsed.data.LLM_DEFAULT_DAILY_BUDGET,
            }
          : undefined,
    };
  }
  return cached;
}

/** 文件超限的统一提示文案（upload route 与 MCP 工具共用，避免多处硬编码换算） */
export function fileTooLargeMessage(): string {
  return `文件超过大小限制（${getEnv().maxFileSizeBytes / 1024 / 1024}MB）`;
}
