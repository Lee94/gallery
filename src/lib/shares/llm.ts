import { and, eq, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "@/db";
import { shareLlmUsage, type Share } from "@/db/schema";
import { getEnv } from "@/lib/env";

// 当日额度统计：按 share 的 24 小时窗口累计 tokens_in+tokens_out
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LlmUsageStats {
  tokensToday: number;
  dailyBudget: number;
  remaining: number;
}

export function getDailyBudget(share: Share): number {
  const env = getEnv();
  return share.llmDailyTokenBudget ?? env.llm?.defaultDailyBudget ?? 50_000;
}

export function getLlmUsageToday(share: Share): LlmUsageStats {
  const since = Date.now() - WINDOW_MS;
  const row = getDb()
    .select({
      total: sql<number>`coalesce(sum(${shareLlmUsage.tokensIn} + ${shareLlmUsage.tokensOut}), 0)`,
    })
    .from(shareLlmUsage)
    .where(and(eq(shareLlmUsage.shareId, share.id), gte(shareLlmUsage.createdAt, since)))
    .get();
  const tokensToday = row?.total ?? 0;
  const dailyBudget = getDailyBudget(share);
  return { tokensToday, dailyBudget, remaining: Math.max(0, dailyBudget - tokensToday) };
}

export function recordUsage(
  shareId: string,
  visitorKey: string | null,
  tokensIn: number,
  tokensOut: number,
): void {
  getDb().insert(shareLlmUsage).values({
    id: nanoid(16),
    shareId,
    visitorKey,
    tokensIn,
    tokensOut,
    createdAt: Date.now(),
  }).run();
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCallInput {
  messages: LlmMessage[];
  responseSchema?: Record<string, unknown>;
  tools?: LlmToolDefinition[];
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface LlmCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  finishReason: string | null;
  toolCalls: LlmToolCall[];
}

export type LlmError = (
  | { code: "not_configured"; message: string }
  | { code: "upstream_error"; message: string; status?: number }
  | { code: "aborted"; message: string }
  | { code: "quota_exceeded"; message: string }
) & { tokensIn?: number; tokensOut?: number };

type Reservation = { shareId: string; actorKey: string; tokens: number };
const activeByShare = new Map<string, { count: number; tokens: number; actors: Map<string, number> }>();

/** 先预留输出额度再并发调用，避免两个长请求同时越过日预算。 */
export function reserveLlmCapacity(
  share: Share,
  actorKey: string,
): Reservation | { error: string; code: "busy" | "quota_exceeded" } {
  const stats = getLlmUsageToday(share);
  const active = activeByShare.get(share.id) ?? { count: 0, tokens: 0, actors: new Map<string, number>() };
  if (active.count >= 2 || (active.actors.get(actorKey) ?? 0) >= 1) {
    return { error: "已有生成任务进行中，请完成或取消后重试", code: "busy" };
  }
  const available = stats.remaining - active.tokens;
  if (available <= 0) return { error: "今日额度已用完", code: "quota_exceeded" };
  const tokens = Math.min(getEnv().llm?.maxTokens ?? 1024, available);
  active.count += 1;
  active.tokens += tokens;
  active.actors.set(actorKey, (active.actors.get(actorKey) ?? 0) + 1);
  activeByShare.set(share.id, active);
  return { shareId: share.id, actorKey, tokens };
}

export function releaseLlmCapacity(reservation: Reservation): void {
  const active = activeByShare.get(reservation.shareId);
  if (!active) return;
  active.count = Math.max(0, active.count - 1);
  active.tokens = Math.max(0, active.tokens - reservation.tokens);
  const count = Math.max(0, (active.actors.get(reservation.actorKey) ?? 1) - 1);
  if (count === 0) active.actors.delete(reservation.actorKey);
  else active.actors.set(reservation.actorKey, count);
  if (active.count === 0) activeByShare.delete(reservation.shareId);
}

function parseToolCalls(input: unknown): LlmToolCall[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((raw, index) => {
    if (typeof raw !== "object" || raw === null) return [];
    const record = raw as {
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    };
    if (record.type !== "function" || !record.function?.name) return [];
    const rawArguments = record.function.arguments ?? "{}";
    let args: unknown = {};
    try { args = JSON.parse(rawArguments); } catch {}
    return [{
      id: record.id ?? `call_${index}`,
      name: record.function.name,
      arguments: args,
      rawArguments,
    }];
  });
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

/** OpenAI 兼容 /chat/completions；流式只用于纯文本，工具和 JSON Schema 使用非流式以保证完整性。 */
export async function callLlm(share: Share, input: LlmCallInput): Promise<LlmCallResult | LlmError> {
  const env = getEnv();
  if (!env.llm) return { code: "not_configured", message: "服务端未配置 LLM（LLM_BASE_URL/LLM_API_KEY）" };
  const model = share.llmModel ?? env.llm.defaultModel;
  const streaming = input.onDelta !== undefined && !input.tools?.length && !input.responseSchema;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 60_000);
  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const res = await fetch(`${env.llm.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.llm.apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: env.llm.maxTokens,
        stream: streaming,
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.toolCalls?.length ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.rawArguments },
            })),
          } : {}),
        })),
        ...(input.tools?.length ? {
          tools: input.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: "auto",
        } : {}),
        ...(input.responseSchema ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: "gallery_output", strict: true, schema: input.responseSchema },
          },
        } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { code: "upstream_error", message: `上游错误 ${res.status}${text ? `：${text.slice(0, 300)}` : ""}`, status: res.status };
    }

    let finishReason: string | null = null;
    let toolCalls: LlmToolCall[] = [];
    let responseModel = model;
    if (streaming) {
      if (!res.body) return { code: "upstream_error", message: "上游没有返回数据流" };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          for (const line of block.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const event = JSON.parse(payload) as {
                model?: string;
                choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              responseModel = event.model ?? responseModel;
              tokensIn = event.usage?.prompt_tokens ?? tokensIn;
              tokensOut = event.usage?.completion_tokens ?? tokensOut;
              for (const choice of event.choices ?? []) {
                const delta = choice.delta?.content ?? "";
                if (delta) { text += delta; input.onDelta?.(delta); }
                if (choice.finish_reason) finishReason = choice.finish_reason;
              }
            } catch {
              // 忽略不完整的供应商扩展事件；正文 JSON 块必须完整才会进入这里。
            }
          }
        }
      }
      if (!tokensIn) tokensIn = estimateTokens(input.messages.map((m) => m.content).join("\n"));
      if (!tokensOut) tokensOut = estimateTokens(text);
    } else {
      const data = await res.json() as {
        model?: string;
        choices?: Array<{
          finish_reason?: string | null;
          message?: { content?: string; tool_calls?: unknown };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      responseModel = data.model ?? model;
      const message = data.choices?.[0]?.message;
      text = message?.content ?? "";
      finishReason = data.choices?.[0]?.finish_reason ?? null;
      toolCalls = parseToolCalls(message?.tool_calls);
      tokensIn = data.usage?.prompt_tokens ?? estimateTokens(input.messages.map((m) => m.content).join("\n"));
      tokensOut = data.usage?.completion_tokens ?? estimateTokens(text);
    }
    return { text, tokensIn, tokensOut, model: responseModel, finishReason, toolCalls };
  } catch (error) {
    const usage = {
      tokensIn: tokensIn || estimateTokens(input.messages.map((m) => m.content).join("\n")),
      tokensOut: tokensOut || estimateTokens(text),
    };
    if (controller.signal.aborted) {
      return { code: "aborted", message: input.signal?.aborted ? "已取消生成" : "上游请求超时", ...usage };
    }
    return { code: "upstream_error", message: error instanceof Error ? error.message : "调用失败", ...usage };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
