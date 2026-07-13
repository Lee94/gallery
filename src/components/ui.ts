// 共享的表单/按钮样式，保持各页面观感一致

export const inputClass =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none " +
  "focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 " +
  "dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-indigo-900";

export const primaryButtonClass =
  "rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white " +
  "hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm " +
  "hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

export const dangerButtonClass =
  "rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 " +
  "hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950";

export const formErrorClass =
  "rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300";
