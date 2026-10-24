"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const VISITOR_KEY_STORAGE = "gallery:visitor-key";

function getOrCreateVisitorKey(): string {
  try {
    const existing = window.localStorage.getItem(VISITOR_KEY_STORAGE);
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) return existing;
    const key = window.crypto.randomUUID();
    window.localStorage.setItem(VISITOR_KEY_STORAGE, key);
    return key;
  } catch {
    return window.crypto.randomUUID();
  }
}

type CommentItem = {
  id: string;
  visitorKey: string | null;
  authorLabel: string;
  body: string;
  isOwner: boolean;
  status: "open" | "resolved" | "hidden";
  createdAt: number;
  resolvedAt: number | null;
};

type Props = {
  slug: string;
  isOwner: boolean;
  visitorWrite?: boolean;
  /** 服务端渲染时传入的初始评论数，避免首屏闪烁 */
  initialCount?: number;
};

export function CommentsPanel({ slug, isOwner, visitorWrite = true, initialCount = 0 }: Props) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [count, setCount] = useState(initialCount);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState("");
  const [authorLabel, setAuthorLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const visitorKey = useRef<string>("");
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      if (visitorKey.current) headers["X-Gallery-Visitor-Key"] = visitorKey.current;
      const res = await fetch(`/api/comments/${encodeURIComponent(slug)}`, {
        headers,
        cache: "no-store",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "加载失败");
      }
      const j = (await res.json()) as { items: CommentItem[] };
      setComments(j.items);
      setCount(j.items.filter((c) => c.status !== "hidden").length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    visitorKey.current = getOrCreateVisitorKey();
  }, []);

  // 面板打开后通过 SSE 接收变更提示；正文仍由受访问控制的 comments API 拉取。
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const refresh = () => {
      if (!disposed) void load();
    };
    const microtask = Promise.resolve().then(refresh);
    const events = new EventSource(`/api/events/${encodeURIComponent(slug)}`);
    events.addEventListener("comments", refresh);
    events.addEventListener("reset", refresh);
    return () => {
      disposed = true;
      events.close();
      void microtask;
    };
  }, [open, load, slug]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [comments.length]);

  const submit = async () => {
    const text = body.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (visitorKey.current) headers["X-Gallery-Visitor-Key"] = visitorKey.current;
      const res = await fetch(`/api/comments/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: text, authorLabel: authorLabel || undefined }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "发送失败");
      }
      setBody("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSubmitting(false);
    }
  };

  const setStatus = async (commentId: string, status: string) => {
    try {
      const res = await fetch(
        `/api/comments/${encodeURIComponent(slug)}/${commentId}/status`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (res.ok) await load();
    } catch {}
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-indigo-600 hover:underline dark:text-indigo-400"
        title="评论"
      >
        评论{count > 0 ? `(${count})` : ""}
      </button>
      {open && (
        <aside className="fixed inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <span className="text-sm font-medium">评论</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              关闭 ✕
            </button>
          </div>
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {loading && comments.length === 0 && (
              <p className="text-sm text-zinc-500">加载中…</p>
            )}
            {!loading && comments.length === 0 && (
              <p className="text-sm text-zinc-500">还没有评论，来抢沙发。</p>
            )}
            {comments.map((c) => (
              <div
                key={c.id}
                className={`rounded-md border px-3 py-2 text-sm ${
                  c.status === "hidden"
                    ? "border-zinc-200 opacity-50 dark:border-zinc-800"
                    : c.status === "resolved"
                      ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/30"
                      : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {c.isOwner ? (
                      <span className="text-indigo-600 dark:text-indigo-400">
                        {c.authorLabel}
                      </span>
                    ) : (
                      c.authorLabel
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-400">
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words">{c.body}</p>
                {isOwner && (
                  <div className="mt-1 flex gap-2 text-xs">
                    {c.status === "open" && (
                      <button
                        type="button"
                        onClick={() => setStatus(c.id, "resolved")}
                        className="text-green-600 hover:underline"
                      >
                        标记已解决
                      </button>
                    )}
                    {c.status === "resolved" && (
                      <button
                        type="button"
                        onClick={() => setStatus(c.id, "open")}
                        className="text-zinc-500 hover:underline"
                      >
                        重新打开
                      </button>
                    )}
                    {c.status !== "hidden" && (
                      <button
                        type="button"
                        onClick={() => setStatus(c.id, "hidden")}
                        className="text-red-500 hover:underline"
                      >
                        隐藏
                      </button>
                    )}
                    {c.status === "hidden" && (
                      <button
                        type="button"
                        onClick={() => setStatus(c.id, "open")}
                        className="text-zinc-500 hover:underline"
                      >
                        恢复
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
            {!isOwner && !visitorWrite && (
              <p className="text-xs text-zinc-500">此分享已设为仅 owner 可发表评论。</p>
            )}
            {!isOwner && visitorWrite && (
              <input
                type="text"
                placeholder="昵称（可选）"
                value={authorLabel}
                onChange={(e) => setAuthorLabel(e.target.value)}
                maxLength={40}
                className="mb-2 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
              />
            )}
            <textarea
              disabled={!isOwner && !visitorWrite}
              placeholder={isOwner ? "回复…" : "写下你的评论…"}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxLength={2000}
              className="w-full resize-none rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            {error && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || !body.trim() || (!isOwner && !visitorWrite)}
              className="mt-2 w-full rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {submitting ? "发送中…" : "发送"}
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
