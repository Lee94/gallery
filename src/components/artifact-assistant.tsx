"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "./ui";

type Message = { role: "user" | "assistant"; content: string };
type LastRequest = { action: "ask" | "modify"; prompt: string };

export function ArtifactAssistant({ slug, configured }: { slug: string; configured: boolean }) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modifiedFiles, setModifiedFiles] = useState<string[]>([]);
  const [lastRequest, setLastRequest] = useState<LastRequest | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const run = async (request: LastRequest) => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setModifiedFiles([]);
    setLastRequest(request);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch(`/api/artifact-ai/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, messages }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as {
        text?: string;
        error?: string;
        modifiedFiles?: string[];
      } | null;
      if (!response.ok || !body?.text) throw new Error(body?.error ?? "生成失败");
      setMessages((current) => [
        ...current,
        { role: "user", content: request.prompt },
        { role: "assistant", content: body.text! },
      ].slice(-12) as Message[]);
      setPrompt("");
      setModifiedFiles(body.modifiedFiles ?? []);
      if (body.modifiedFiles?.length) router.refresh();
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "AbortError"
        ? "已取消生成"
        : cause instanceof Error ? cause.message : "生成失败");
    } finally {
      setLoading(false);
      controllerRef.current = null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">询问或修改 Artifact</h2>
        <p className="mt-1 text-xs text-zinc-500">服务端会附带当前文本源码；多轮对话仅保留在你的浏览器中。修改会写入文件并自动生成版本。</p>
        {!configured ? (
          <p className="mt-4 text-sm text-zinc-500">请先在服务端配置 LLM_BASE_URL 和 LLM_API_KEY。</p>
        ) : (
          <>
            {messages.length > 0 && (
              <div className="mt-4 flex max-h-96 flex-col gap-3 overflow-y-auto rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
                {messages.map((message, index) => (
                  <div key={index} className={message.role === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
                    <span className="text-xs text-zinc-500">{message.role === "user" ? "你" : "AI"}</span>
                    <p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">{message.content}</p>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
              maxLength={8192}
              placeholder="例如：解释数据如何保存；或把页面改成深色并增加一个重置按钮"
              className={inputClass + " mt-4 resize-y"}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={loading || !prompt.trim()} onClick={() => void run({ action: "ask", prompt: prompt.trim() })} className={secondaryButtonClass}>询问</button>
              <button type="button" disabled={loading || !prompt.trim()} onClick={() => void run({ action: "modify", prompt: prompt.trim() })} className={primaryButtonClass}>修改 Artifact</button>
              {loading && <button type="button" onClick={() => controllerRef.current?.abort()} className={secondaryButtonClass}>取消</button>}
              {!loading && lastRequest && <button type="button" onClick={() => void run(lastRequest)} className={secondaryButtonClass}>重试</button>}
            </div>
            {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
            {modifiedFiles.length > 0 && <p className="mt-3 break-all text-sm text-green-700 dark:text-green-300">已修改：{modifiedFiles.join("、")}</p>}
          </>
        )}
      </section>
    </div>
  );
}
