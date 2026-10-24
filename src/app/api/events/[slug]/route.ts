import type { NextRequest } from "next/server";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { resolveShareAccess } from "@/lib/share-access";
import { getKvPolicy } from "@/lib/shares/kv";
import {
  currentShareEventId,
  replayShareEvents,
  subscribeShareEvents,
  type ShareEvent,
} from "@/lib/share-events";

function eventBlock(event: ShareEvent | { id: number; type: "ready" | "reset" }): string {
  const { id, type, ...detail } = event;
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(detail)}\n\n`;
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const access = await resolveShareAccess(slug);
  if (access.status === "not_found") {
    return Response.json({ error: "不可用", code: "not_found" }, { status: 404 });
  }
  if (access.status === "locked") {
    return Response.json({ error: "请先输入分享访问密码", code: "locked" }, { status: 403 });
  }

  const canReceive = (event: ShareEvent) =>
    event.type !== "kv" ||
    !event.collection ||
    access.isOwner ||
    getKvPolicy(access.share.id, event.collection).readMode === "all";

  const ip = await getClientIp();
  if (!rateLimit(`events:${ip}:${access.share.id}`, 30, 60_000)) {
    return Response.json({ error: "连接过于频繁", code: "rate_limited" }, { status: 429 });
  }

  const rawAfter =
    request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("since");
  const afterId = rawAfter === null ? currentShareEventId() : Number(rawAfter);
  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    return Response.json({ error: "事件序号不正确", code: "invalid_event_id" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let onAbort: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let sentId = afterId;
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        if (onAbort) request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // cancel() 已经关闭流。
        }
      };
      onAbort = close;
      request.signal.addEventListener("abort", close, { once: true });

      send("retry: 3000\n\n");
      // 先订阅再重放；listener 用 sentId 去重，避免 subscribe 与 replay 之间丢事件。
      unsubscribe = subscribeShareEvents(access.share.id, (event) => {
        if (event.id <= sentId) return;
        sentId = event.id;
        if (canReceive(event)) send(eventBlock(event));
      });

      const replay = replayShareEvents(access.share.id, afterId);
      if (replay.reset) {
        sentId = replay.currentId;
        send(eventBlock({ id: replay.currentId, type: "reset" }));
      } else {
        for (const event of replay.events) {
          if (event.id <= sentId) continue;
          sentId = event.id;
          send(eventBlock(event));
        }
        if (rawAfter === null) {
          send(eventBlock({ id: replay.currentId, type: "ready" }));
          sentId = replay.currentId;
        }
      }

      heartbeat = setInterval(() => send(": heartbeat\n\n"), 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      if (onAbort) request.signal.removeEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
