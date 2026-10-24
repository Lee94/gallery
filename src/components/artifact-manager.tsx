"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  clearShareKvCollection,
  deleteShare,
  deleteShareFile,
  moderateShareComment,
  publishShareVersion,
  removeSharePassword,
  replyToShare,
  resetShareDataSpace,
  resetSharePageState,
  resetShareVisitorState,
  rollbackShareVersion,
  saveShareTextFile,
  setShareAttachmentsEnabled,
  setShareCommentsEnabled,
  setShareCommentsVisitorWrite,
  setShareDataSchemaVersion,
  setShareExpiry,
  setShareKvEnabled,
  setShareKvPolicy,
  setShareLlmEnabled,
  setShareMetadata,
  setSharePageStateEnabled,
  setSharePassword,
  setShareVisitorStateEnabled,
  type ShareActionResult,
} from "@/actions/shares";
import { formatDateTime } from "@/lib/format";
import { ArtifactAssistant } from "./artifact-assistant";
import {
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./ui";

export type ManagedShare = {
  id: string;
  slug: string;
  originalName: string;
  title: string | null;
  description: string;
  icon: string;
  coverPath: string | null;
  sourceEnabled: boolean;
  forkedFromSlug: string | null;
  kind: string;
  runtime: "static" | "react";
  runtimeVersion: string;
  size: number;
  entryPath: string;
  createdAt: number;
  updatedAt: number;
  hasPassword: boolean;
  expiresAt: number | null;
  pageStateEnabled: boolean;
  visitorStateEnabled: boolean;
  kvEnabled: boolean;
  attachmentsEnabled: boolean;
  commentsEnabled: boolean;
  commentsVisitorWrite: boolean;
  dataGeneration: number;
  dataSchemaVersion: number;
  llmEnabled: boolean;
  llmDailyTokenBudget: number | null;
  llmModel: string | null;
  llmConfigured: boolean;
};

export type ManagedFile = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  isEntry: boolean;
  textContent: string | null;
};

export type ManagedVersion = {
  versionNo: number;
  label: string | null;
  fileCount: number;
  createdAt: number;
};

export type ManagedComment = {
  id: string;
  authorLabel: string;
  body: string;
  isOwner: boolean;
  status: "open" | "resolved" | "hidden";
  createdAt: number;
};

export type ManagedPageState = {
  prettyJson: string;
  version: number;
  sizeBytes: number;
  updatedAt: number;
} | null;

export type ManagedKvItem = {
  key: string;
  valueText: string;
  version: number;
  sizeBytes: number;
  updatedAt: number;
};

export type ManagedKvPolicy = {
  collection: string;
  readMode: "all" | "owner" | "creator";
  writeMode: "all" | "owner" | "creator";
  deleteMode: "all" | "owner" | "creator";
};

type Props = {
  share: ManagedShare;
  files: ManagedFile[];
  versions: ManagedVersion[];
  pageState: ManagedPageState;
  visitorStateCount: number;
  kvCollection: string;
  kvPolicy: ManagedKvPolicy;
  kvItems: ManagedKvItem[];
  kvHasMore: boolean;
  comments: ManagedComment[];
  llmUsage: { tokensToday: number; dailyBudget: number; remaining: number };
};

type Tab = "files" | "versions" | "data" | "comments" | "ai" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "files", label: "文件" },
  { id: "versions", label: "版本" },
  { id: "data", label: "数据" },
  { id: "comments", label: "评论" },
  { id: "ai", label: "AI" },
  { id: "settings", label: "设置" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function rawFileUrl(slug: string, path: string): string {
  return `/api/raw/${encodeURIComponent(slug)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function toLocalInputValue(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 text-xs text-zinc-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-indigo-600"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-zinc-500">{description}</span>
      </span>
    </label>
  );
}

export function ArtifactManager(props: Props) {
  const { share } = props;
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("files");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const firstFile = props.files[0];
  const [selectedPath, setSelectedPath] = useState(firstFile?.path ?? "index.html");
  const [fileContent, setFileContent] = useState(firstFile?.textContent ?? "");
  const [versionLabel, setVersionLabel] = useState("");
  const [versionDataMode, setVersionDataMode] = useState<"keep" | "new">("keep");
  const [dataSchemaVersion, setDataSchemaVersion] = useState(String(share.dataSchemaVersion));
  const [collection, setCollection] = useState(props.kvCollection);
  const [kvPolicy, setKvPolicy] = useState(props.kvPolicy);
  const [reply, setReply] = useState("");
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState(toLocalInputValue(share.expiresAt));
  const [llmBudget, setLlmBudget] = useState(
    share.llmDailyTokenBudget === null ? "" : String(share.llmDailyTokenBudget),
  );
  const [llmModel, setLlmModel] = useState(share.llmModel ?? "");
  const [title, setTitle] = useState(share.title ?? "");
  const [description, setDescription] = useState(share.description);
  const [icon, setIcon] = useState(share.icon);
  const [coverPath, setCoverPath] = useState(share.coverPath ?? "");
  const [sourceEnabled, setSourceEnabled] = useState(share.sourceEnabled);

  const selectedFile = props.files.find((file) => file.path === selectedPath);
  const canEditSelected = !selectedFile || selectedFile.textContent !== null;

  const run = (
    action: () => Promise<ShareActionResult>,
    success: string,
    after?: () => void,
  ) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) {
          setError(result.error);
          return;
        }
        setNotice(success);
        after?.();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作失败，请稍后重试");
      }
    });
  };

  const selectFile = (file: ManagedFile) => {
    setSelectedPath(file.path);
    setFileContent(file.textContent ?? "");
    setError(null);
  };

  const llmOptions = () => ({
    dailyTokenBudget: llmBudget.trim() ? Number(llmBudget) : null,
    model: llmModel.trim() || null,
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/dashboard" className="text-xs text-zinc-500 hover:underline">
            ← 返回文件列表
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold" title={share.title ?? share.originalName}>
            {share.icon && <span className="mr-2">{share.icon}</span>}{share.title ?? share.originalName}
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            /s/{share.slug} · 更新于 <span suppressHydrationWarning>{formatDateTime(share.updatedAt)}</span>
            {share.runtime === "react" && <span className="ml-2 text-violet-600">React {share.runtimeVersion} · 锁定依赖</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/s/${share.slug}`}
            target="_blank"
            rel="noreferrer"
            className={secondaryButtonClass}
          >
            打开分享 ↗
          </a>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`shrink-0 border-b-2 px-3 py-2 text-sm ${
              tab === item.id
                ? "border-indigo-600 font-medium text-indigo-600"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {pending && <p className="text-xs text-zinc-500">正在保存并刷新…</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      {tab === "files" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
          <Section title={`文件清单（${props.files.length}）`} description={`入口：${share.entryPath}`}>
            <ul className="flex max-h-[32rem] flex-col gap-1 overflow-y-auto">
              {props.files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => selectFile(file)}
                    className={`w-full rounded-md px-2 py-2 text-left text-xs ${
                      selectedPath === file.path
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    }`}
                  >
                    <span className="block break-all font-medium">{file.path}</span>
                    <span className="mt-0.5 block text-zinc-500">
                      {formatSize(file.sizeBytes)}{file.isEntry ? " · 入口" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={secondaryButtonClass + " mt-3 w-full"}
              onClick={() => {
                setSelectedPath("");
                setFileContent("");
              }}
            >
              新建文本文件
            </button>
          </Section>

          <Section
            title={selectedFile ? `编辑 ${selectedFile.path}` : "新建文本文件"}
            description="保存后原分享链接不变，并自动生成一个新版本。修改已有路径会覆盖该文件。"
          >
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">相对路径</span>
                <input
                  value={selectedPath}
                  onChange={(e) => setSelectedPath(e.target.value)}
                  placeholder="如 index.html / js/app.js"
                  className={inputClass + " font-mono"}
                  maxLength={512}
                />
              </label>
              {canEditSelected ? (
                <textarea
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  placeholder="输入文本内容"
                  spellCheck={false}
                  className={inputClass + " min-h-96 resize-y font-mono text-xs leading-5"}
                />
              ) : (
                <p className="rounded-md bg-zinc-50 p-4 text-sm text-zinc-500 dark:bg-zinc-900">
                  二进制文件或超过在线编辑上限的文件不能直接编辑，请下载后重新上传。
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending || !canEditSelected || !selectedPath || !fileContent}
                  onClick={() => run(() => saveShareTextFile(share.id, selectedPath, fileContent), "文件已保存")}
                  className={primaryButtonClass}
                >
                  保存文件
                </button>
                {selectedFile && (
                  <a href={rawFileUrl(share.slug, selectedFile.path)} className={secondaryButtonClass}>
                    查看原始文件
                  </a>
                )}
                {selectedFile && !selectedFile.isEntry && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (!confirm(`确定删除 ${selectedFile.path}？`)) return;
                      run(() => deleteShareFile(share.id, selectedFile.path), "文件已删除", () => {
                        setSelectedPath(share.entryPath);
                        setFileContent("");
                      });
                    }}
                    className={dangerButtonClass}
                  >
                    删除文件
                  </button>
                )}
              </div>
            </div>
          </Section>
        </div>
      )}

      {tab === "versions" && (
        <Section title="版本历史" description="每次文件变更会自动快照；也可以为当前状态打一个带标签的版本。最多保留 50 个版本。">
          <div className="mb-4 flex flex-wrap gap-2">
            <input
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
              placeholder="版本标签，如 draft 2"
              maxLength={100}
              className={inputClass + " min-w-56 flex-1"}
            />
            <select
              value={versionDataMode}
              onChange={(e) => setVersionDataMode(e.target.value as "keep" | "new")}
              className={inputClass}
              title="选择新版本沿用当前数据，还是清空并创建新的数据空间"
            >
              <option value="keep">沿用当前数据</option>
              <option value="new">新建数据空间</option>
            </select>
            <button
              type="button"
              disabled={pending || !versionLabel.trim()}
              onClick={() => {
                if (versionDataMode === "new" && !confirm("发布会清空页面、访客和 KV 数据，并创建新数据空间。确定继续？")) return;
                run(() => publishShareVersion(share.id, versionLabel, versionDataMode), "版本已发布", () => setVersionLabel(""));
              }}
              className={primaryButtonClass}
            >
              发布当前版本
            </button>
          </div>
          {props.versions.length === 0 ? (
            <p className="text-sm text-zinc-500">还没有版本历史。</p>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {props.versions.map((version) => (
                <li key={version.versionNo} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <span className="w-12 font-mono font-medium">v{version.versionNo}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{version.label ?? "自动快照"}</span>
                    <span className="text-xs text-zinc-500" suppressHydrationWarning>
                      {version.fileCount} 个文件 · {formatDateTime(version.createdAt)}
                    </span>
                  </span>
                  <a
                    href={`/s/${share.slug}?v=${version.versionNo}`}
                    target="_blank"
                    rel="noreferrer"
                    className={secondaryButtonClass}
                  >
                    预览
                  </a>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (!confirm(`回滚到 v${version.versionNo}？当前文件会被替换，并生成一个新版本。`)) return;
                      run(() => rollbackShareVersion(share.id, version.versionNo), `已回滚到 v${version.versionNo}`);
                    }}
                    className={secondaryButtonClass}
                  >
                    回滚
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {tab === "data" && (
        <div className="flex flex-col gap-4">
          <Section
            title="数据兼容与隔离"
            description={`当前数据空间 #${share.dataGeneration}。页面可用 Gallery.requireDataSchema(version) 声明所需结构；不匹配时读写返回 409，避免旧页面误写。`}
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">dataSchemaVersion</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={dataSchemaVersion}
                  onChange={(e) => setDataSchemaVersion(e.target.value)}
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                disabled={pending || !Number.isSafeInteger(Number(dataSchemaVersion)) || Number(dataSchemaVersion) < 1}
                onClick={() => run(() => setShareDataSchemaVersion(share.id, Number(dataSchemaVersion)), "数据 schema 版本已更新")}
                className={secondaryButtonClass}
              >
                保存 schema 版本
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">升级 schema 不会清空数据；需要彻底隔离旧数据时，请使用下方“新建数据空间”。</p>
          </Section>

          <Section title="共享页面数据" description="所有能访问分享的访客共用这份 JSON。历史版本预览不连接当前数据。">
            {props.pageState ? (
              <>
                <p className="mb-2 text-xs text-zinc-500" suppressHydrationWarning>
                  v{props.pageState.version} · {formatSize(props.pageState.sizeBytes)} · 更新于 {formatDateTime(props.pageState.updatedAt)}
                </p>
                <pre className="max-h-80 overflow-auto rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-900">{props.pageState.prettyJson}</pre>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (confirm("确定清空共享页面数据？此操作不可撤销。")) {
                      run(() => resetSharePageState(share.id), "共享页面数据已清空");
                    }
                  }}
                  className={dangerButtonClass + " mt-3"}
                >
                  清空共享数据
                </button>
              </>
            ) : (
              <p className="text-sm text-zinc-500">共享页面数据未启用。</p>
            )}
          </Section>

          <Section title="访客私有数据" description="这里只显示访客数量，不读取任何访客的私有 JSON。">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">{props.visitorStateCount} 份访客数据</p>
            <button
              type="button"
              disabled={pending || !share.visitorStateEnabled}
              onClick={() => {
                if (confirm("确定清空所有访客私有数据？此操作不可撤销。")) {
                  run(() => resetShareVisitorState(share.id), "访客数据已清空");
                }
              }}
              className={dangerButtonClass + " mt-3"}
            >
              清空所有访客数据
            </button>
          </Section>

          <Section title="KV 数据浏览器" description="按 collection 查看行数据。清空 collection 仅 owner 可执行。">
            <form
              className="mb-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(`/dashboard/${share.slug}?collection=${encodeURIComponent(collection)}`);
              }}
            >
              <input
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                className={inputClass + " flex-1 font-mono"}
                placeholder="collection"
                maxLength={64}
              />
              <button type="submit" disabled={!collection} className={secondaryButtonClass}>查看</button>
            </form>
            <div className="mb-4 grid gap-2 rounded-md bg-zinc-50 p-3 sm:grid-cols-3 dark:bg-zinc-900">
              {([
                ["readMode", "读取"],
                ["writeMode", "写入/覆盖"],
                ["deleteMode", "删除"],
              ] as const).map(([mode, label]) => (
                <label key={mode} className="flex flex-col gap-1">
                  <span className="text-xs text-zinc-500">{label}权限</span>
                  <select
                    value={kvPolicy[mode]}
                    onChange={(e) => setKvPolicy((current) => ({
                      ...current,
                      collection: props.kvCollection,
                      [mode]: e.target.value,
                    }))}
                    className={inputClass}
                  >
                    <option value="all">所有访客</option>
                    <option value="owner">仅 owner</option>
                    {mode !== "readMode" && <option value="creator">行创建者 + owner</option>}
                  </select>
                </label>
              ))}
              <button
                type="button"
                disabled={pending || !share.kvEnabled}
                onClick={() => run(() => setShareKvPolicy(share.id, { ...kvPolicy, collection: props.kvCollection }), "KV 权限已保存")}
                className={secondaryButtonClass + " self-end sm:col-span-3 sm:justify-self-start"}
              >
                保存当前 collection 权限
              </button>
            </div>
            {props.kvItems.length === 0 ? (
              <p className="text-sm text-zinc-500">这个 collection 没有数据。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {props.kvItems.map((item) => (
                  <li key={item.key} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                    <p className="break-all text-xs font-medium">{item.key}</p>
                    <p className="mt-0.5 text-xs text-zinc-500" suppressHydrationWarning>
                      v{item.version} · {formatSize(item.sizeBytes)} · {formatDateTime(item.updatedAt)}
                    </p>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-600 dark:text-zinc-300">{item.valueText}</pre>
                  </li>
                ))}
              </ul>
            )}
            {props.kvHasMore && <p className="mt-2 text-xs text-zinc-500">仅显示前 50 行，请使用 MCP 分页查看更多。</p>}
            <button
              type="button"
              disabled={pending || !share.kvEnabled || !props.kvCollection}
              onClick={() => {
                if (confirm(`确定清空 collection「${props.kvCollection}」的所有行？`)) {
                  run(() => clearShareKvCollection(share.id, props.kvCollection), "collection 已清空");
                }
              }}
              className={dangerButtonClass + " mt-3"}
            >
              清空当前 collection
            </button>
          </Section>
        </div>
      )}

      {tab === "comments" && (
        <Section title={`评论管理（${props.comments.length}）`} description="可回复、解决或隐藏评论；关闭评论功能不会删除历史内容。">
          {props.comments.length === 0 ? (
            <p className="text-sm text-zinc-500">还没有评论。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {props.comments.map((comment) => (
                <li key={comment.id} className={`rounded-md border p-3 text-sm ${comment.status === "hidden" ? "border-zinc-200 opacity-60 dark:border-zinc-800" : "border-zinc-200 dark:border-zinc-800"}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{comment.authorLabel}{comment.isOwner ? "（owner）" : ""}</span>
                    <span className="text-xs text-zinc-500" suppressHydrationWarning>{formatDateTime(comment.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words">{comment.body}</p>
                  <div className="mt-2 flex gap-2 text-xs">
                    {comment.status !== "open" && (
                      <button type="button" disabled={pending} onClick={() => run(() => moderateShareComment(share.id, comment.id, "open"), "评论已重新打开")} className={secondaryButtonClass}>打开</button>
                    )}
                    {comment.status !== "resolved" && (
                      <button type="button" disabled={pending} onClick={() => run(() => moderateShareComment(share.id, comment.id, "resolved"), "评论已标记为解决")} className={secondaryButtonClass}>标记解决</button>
                    )}
                    {comment.status !== "hidden" && (
                      <button type="button" disabled={pending} onClick={() => run(() => moderateShareComment(share.id, comment.id, "hidden"), "评论已隐藏")} className={secondaryButtonClass}>隐藏</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="以 owner 身份发表评论"
              rows={3}
              maxLength={2000}
              className={inputClass + " resize-y"}
            />
            <button
              type="button"
              disabled={pending || !share.commentsEnabled || !reply.trim()}
              onClick={() => run(() => replyToShare(share.id, reply), "评论已发表", () => setReply(""))}
              className={primaryButtonClass + " self-start"}
            >
              发表评论
            </button>
          </div>
        </Section>
      )}

      {tab === "ai" && <ArtifactAssistant slug={share.slug} configured={share.llmConfigured} />}

      {tab === "settings" && (
        <div className="flex flex-col gap-4">
          <Section title="展示与分享元数据" description="用于分享页标题、Open Graph 和嵌入。封面只能选择分享内的位图文件。">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">显示标题</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={share.originalName} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">图标（Emoji 或短文本）</span>
                <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={16} placeholder="✨" className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs text-zinc-500">描述</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Open Graph 封面</span>
                <select value={coverPath} onChange={(e) => setCoverPath(e.target.value)} className={inputClass}>
                  <option value="">无封面</option>
                  {props.files.filter((file) => file.mimeType.startsWith("image/") && file.mimeType !== "image/svg+xml").map((file) => (
                    <option key={file.path} value={file.path}>{file.path}</option>
                  ))}
                </select>
              </label>
              <ToggleRow title="允许公开源码浏览" description="访客可通过 ?source=1 查看文本源码和文件清单。" checked={sourceEnabled} disabled={pending} onChange={setSourceEnabled} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => setShareMetadata(share.id, {
                  title: title || null,
                  description,
                  icon,
                  coverPath: coverPath || null,
                  sourceEnabled,
                }), "展示元数据已保存")}
                className={primaryButtonClass}
              >
                保存元数据
              </button>
              <a href={`/s/${share.slug}?embed=1`} target="_blank" rel="noreferrer" className={secondaryButtonClass}>嵌入预览 ↗</a>
            </div>
            <label className="mt-3 flex flex-col gap-1">
              <span className="text-xs text-zinc-500">嵌入代码</span>
              <input readOnly onFocus={(e) => e.target.select()} value={`<iframe src="/s/${share.slug}?embed=1" style="width:100%;height:600px;border:0"></iframe>`} className={inputClass + " font-mono text-xs"} />
            </label>
            {share.forkedFromSlug && <p className="mt-2 text-xs text-zinc-500">Fork 自 <a className="hover:underline" href={`/s/${share.forkedFromSlug}`}>/s/{share.forkedFromSlug}</a></p>}
          </Section>

          <Section title="Artifact 能力" description="停用能力只关闭访问，已有数据会保留。HTML 之外的分享只能开启评论。">
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              <ToggleRow title="共享页面数据" description="所有访客共用一份可写 JSON。" checked={share.pageStateEnabled} disabled={pending || share.kind !== "html"} onChange={(enabled) => run(() => setSharePageStateEnabled(share.id, enabled), enabled ? "已启用共享页面数据" : "已停用共享页面数据")} />
              <ToggleRow title="访客私有数据" description="每个访客拥有独立的 JSON 快照。" checked={share.visitorStateEnabled} disabled={pending || share.kind !== "html"} onChange={(enabled) => run(() => setShareVisitorStateEnabled(share.id, enabled), enabled ? "已启用访客数据" : "已停用访客数据")} />
              <ToggleRow title="行级 KV 数据" description="collection/key 行集，支持 CAS 与批量操作。" checked={share.kvEnabled} disabled={pending || share.kind !== "html"} onChange={(enabled) => run(() => setShareKvEnabled(share.id, enabled), enabled ? "已启用 KV" : "已停用 KV")} />
              <ToggleRow title="访客附件" description="允许页面上传私有或分享内共享的附件，并受单文件、访客和总配额限制。" checked={share.attachmentsEnabled} disabled={pending || share.kind !== "html"} onChange={(enabled) => run(() => setShareAttachmentsEnabled(share.id, enabled), enabled ? "已启用访客附件" : "已停用访客附件")} />
              <ToggleRow title="访客评论" description="在分享页显示公开评论面板。" checked={share.commentsEnabled} disabled={pending} onChange={(enabled) => run(() => setShareCommentsEnabled(share.id, enabled), enabled ? "已启用评论" : "已停用评论")} />
              <ToggleRow title="允许访客发表评论" description="关闭后评论只读，owner 仍可回复和审核。" checked={share.commentsVisitorWrite} disabled={pending || !share.commentsEnabled} onChange={(enabled) => run(() => setShareCommentsVisitorWrite(share.id, enabled), enabled ? "已允许访客评论" : "已设为仅 owner 可评论")} />
            </div>
          </Section>

          <Section title="页面内 LLM" description={share.llmConfigured ? `今日已用 ${props.llmUsage.tokensToday} / ${props.llmUsage.dailyBudget} tokens。` : "服务端尚未配置 LLM_BASE_URL / LLM_API_KEY。"}>
            <ToggleRow title="允许页面调用 LLM" description="密钥只保留在服务端；页面通过父页面桥接调用。" checked={share.llmEnabled} disabled={pending || share.kind !== "html" || !share.llmConfigured} onChange={(enabled) => { const options = llmOptions(); run(() => setShareLlmEnabled(share.id, enabled, options.dailyTokenBudget, options.model), enabled ? "已启用 LLM" : "已停用 LLM"); }} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">每日 token 配额（留空使用全局默认）</span>
                <input type="number" min="1" step="1" value={llmBudget} onChange={(e) => setLlmBudget(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">模型（留空使用全局默认）</span>
                <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} maxLength={100} className={inputClass} />
              </label>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => { const options = llmOptions(); run(() => setShareLlmEnabled(share.id, share.llmEnabled, options.dailyTokenBudget, options.model), "LLM 配置已保存"); }}
              className={secondaryButtonClass + " mt-3"}
            >
              保存 LLM 配置
            </button>
          </Section>

          <Section title="访问控制">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">访问密码</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={share.hasPassword ? "输入新密码" : "可选"} maxLength={200} className={inputClass} />
              </label>
              <button type="button" disabled={pending || !password} onClick={() => run(() => setSharePassword(share.id, password), "密码已更新", () => setPassword(""))} className={secondaryButtonClass}>保存密码</button>
              {share.hasPassword && <button type="button" disabled={pending} onClick={() => run(() => removeSharePassword(share.id), "密码已移除")} className={secondaryButtonClass}>移除密码</button>}
            </div>
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">过期时间</span>
                <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputClass} />
              </label>
              <button type="button" disabled={pending || !expiry} onClick={() => run(() => setShareExpiry(share.id, new Date(expiry).getTime()), "过期时间已更新")} className={secondaryButtonClass}>保存时间</button>
              <button type="button" disabled={pending || share.expiresAt === null} onClick={() => run(() => setShareExpiry(share.id, null), "已设为永不过期", () => setExpiry(""))} className={secondaryButtonClass}>永不过期</button>
            </div>
          </Section>

          <Section title="危险操作">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (!confirm("确定新建数据空间？共享页面、所有访客私有数据和全部 KV 行都会永久清空，旧页面将无法继续写入。")) return;
                  run(() => resetShareDataSpace(share.id), "已创建新数据空间");
                }}
                className={dangerButtonClass}
              >
                清空数据并新建数据空间
              </button>
              <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!confirm(`确定删除「${share.originalName}」？文件、版本和数据都会删除，链接立即失效。`)) return;
                run(() => deleteShare(share.id), "分享已删除", () => router.push("/dashboard"));
              }}
              className={dangerButtonClass}
            >
              删除整个分享
              </button>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}
