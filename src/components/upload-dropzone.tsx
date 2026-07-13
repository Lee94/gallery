"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type UploadItem = {
  key: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
};

export function UploadDropzone({ maxFileSizeMb }: { maxFileSizeMb: number }) {
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = (key: string, changes: Partial<UploadItem>) =>
    setItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...changes } : it)),
    );

  const upload = (file: File) => {
    const key = `${file.name}-${Date.now()}-${Math.random()}`;
    if (file.size > maxFileSizeMb * 1024 * 1024) {
      setItems((prev) => [
        ...prev,
        {
          key,
          name: file.name,
          progress: 0,
          status: "error",
          error: `超过 ${maxFileSizeMb}MB 大小限制`,
        },
      ]);
      return;
    }

    setItems((prev) => [
      ...prev,
      { key, name: file.name, progress: 0, status: "uploading" },
    ]);

    // 用 XHR 而不是 fetch：需要 upload.onprogress 显示上传进度
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        patch(key, { progress: Math.round((e.loaded / e.total) * 100) });
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        patch(key, { status: "done", progress: 100 });
        router.refresh();
      } else {
        let error = "上传失败";
        try {
          error = JSON.parse(xhr.responseText).error ?? error;
        } catch {
          // 非 JSON 响应（如代理返回的错误页）
        }
        patch(key, { status: "error", error });
      }
    };
    xhr.onerror = () => patch(key, { status: "error", error: "网络错误" });

    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) upload(file);
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragOver
            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950"
            : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"
        }`}
      >
        <p className="text-sm font-medium">点击或拖拽文件到此处上传</p>
        <p className="text-xs text-zinc-500">
          HTML、PDF、图片、Markdown 等，单个文件最大 {maxFileSizeMb}MB
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {items.map((it) => (
            <li
              key={it.key}
              className="flex items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
            >
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              {it.status === "uploading" && (
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <span
                      className="block h-full rounded-full bg-indigo-500 transition-all"
                      style={{ width: `${it.progress}%` }}
                    />
                  </span>
                  <span className="w-9 text-right text-xs tabular-nums text-zinc-500">
                    {it.progress}%
                  </span>
                </span>
              )}
              {it.status === "done" && (
                <span className="text-xs text-green-600 dark:text-green-400">
                  已上传
                </span>
              )}
              {it.status === "error" && (
                <span className="text-xs text-red-600 dark:text-red-400">
                  {it.error}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
