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

export function UploadDropzone({
  maxFileSizeMb,
  maxPageStateSizeKb,
}: {
  maxFileSizeMb: number;
  maxPageStateSizeKb: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [pageStateEnabled, setPageStateEnabled] = useState(false);
  const [visitorStateEnabled, setVisitorStateEnabled] = useState(false);
  const [artifactMode, setArtifactMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const patch = (key: string, changes: Partial<UploadItem>) =>
    setItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...changes } : it)),
    );

  const uploadSingle = (file: File) => {
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
        } catch {}
        patch(key, { status: "error", error });
      }
    };
    xhr.onerror = () => patch(key, { status: "error", error: "网络错误" });

    const fd = new FormData();
    fd.append("file", file);
    fd.append("pageStateEnabled", String(pageStateEnabled));
    fd.append("visitorStateEnabled", String(visitorStateEnabled));
    if (/\.(jsx|tsx)$/i.test(file.name)) fd.append("runtime", "react");
    xhr.send(fd);
  };

  /** 多文件 artifact：所有 File 打成一个 share 上传 */
  const uploadArtifact = (files: File[]) => {
    const first = files[0];
    if (!first) return;
    const label = files.length === 1 ? first.name : `${files.length} 个文件`;
    const key = `artifact-${Date.now()}-${Math.random()}`;

    // 入口优先 index.html；React Artifact 使用 index.jsx/index.tsx 或唯一 JSX 文件。
    const entry =
      files.find((f) => {
        const rel =
          (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
          f.name;
        return rel.endsWith("/index.html") || rel === "index.html";
      }) ??
      files.find((f) => /(^|\/)(index|App)\.(jsx|tsx)$/i.test(f.name) || /(^|\/)(index|App)\.(jsx|tsx)$/i.test((f as File & { webkitRelativePath?: string }).webkitRelativePath ?? "")) ??
      files.find((f) => f.name.endsWith(".html")) ??
      files.find((f) => /\.(jsx|tsx)$/i.test(f.name));
    if (!entry) {
      setItems((prev) => [
        ...prev,
        {
          key,
          name: label,
          progress: 0,
          status: "error",
          error: "未找到入口（需要 index.html、index.jsx、index.tsx 或至少一个 HTML/JSX 文件）",
        },
      ]);
      return;
    }
    const entryRel =
      (entry as File & { webkitRelativePath?: string }).webkitRelativePath ||
      entry.name;
    const entryPath = entryRel.split("/").slice(1).join("/") || entry.name;

    const totalSize = files.reduce((s, f) => s + f.size, 0);
    if (totalSize > maxFileSizeMb * 1024 * 1024) {
      setItems((prev) => [
        ...prev,
        {
          key,
          name: label,
          progress: 0,
          status: "error",
          error: `总大小超过 ${maxFileSizeMb}MB 限制`,
        },
      ]);
      return;
    }

    setItems((prev) => [
      ...prev,
      { key, name: `${label} → ${entryPath}`, progress: 0, status: "uploading" },
    ]);

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
        } catch {}
        patch(key, { status: "error", error });
      }
    };
    xhr.onerror = () => patch(key, { status: "error", error: "网络错误" });

    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    fd.append("entryPath", entryPath);
    if (/\.(jsx|tsx)$/i.test(entryPath)) fd.append("runtime", "react");
    fd.append("pageStateEnabled", String(pageStateEnabled));
    fd.append("visitorStateEnabled", String(visitorStateEnabled));
    xhr.send(fd);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files);
    if (artifactMode || arr.length > 1) {
      // 多文件总是按 artifact 打包；单文件看开关
      uploadArtifact(arr);
    } else {
      uploadSingle(arr[0]!);
    }
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
          单个文件直接上传；多选/目录会打成一个多文件 artifact
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
        <input
          ref={dirInputRef}
          type="file"
          // @ts-expect-error 非标准属性，浏览器支持
          webkitdirectory=""
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={pageStateEnabled}
            onChange={(e) => setPageStateEnabled(e.target.checked)}
            className="mt-1 accent-indigo-600"
          />
          <span>
            <span className="font-medium">为本次上传的 HTML 启用共享页面数据</span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              所有能打开分享的人共用并可修改一份 JSON；其他访客刷新后看到变化；每份最大 {maxPageStateSizeKb}KB。页面需接入 Gallery SDK（window.GalleryPageState）。
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={visitorStateEnabled}
            onChange={(e) => setVisitorStateEnabled(e.target.checked)}
            className="mt-1 accent-indigo-600"
          />
          <span>
            <span className="font-medium">启用访客私有数据</span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              每个访客有独立可写 JSON，互不可见（适合记录「我的进度/笔记」等）。页面需接入 Gallery SDK（window.GalleryVisitorState）。
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={artifactMode}
            onChange={(e) => setArtifactMode(e.target.checked)}
            className="mt-1 accent-indigo-600"
          />
          <span>
            <span className="font-medium">强制按多文件 artifact 上传</span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              即使只选一个文件也按多文件 share 打包；主要用于拖入目录或多选场景。多文件上传会自动以 index.html 为入口。
            </span>
          </span>
        </label>

        <button
          type="button"
          onClick={() => dirInputRef.current?.click()}
          className="self-start rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          选择整个目录上传
        </button>
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
