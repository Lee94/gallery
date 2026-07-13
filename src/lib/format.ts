// 时间戳格式化（本地时区）。多个页面/组件展示服务端传来的 unix 毫秒时间戳，
// 客户端组件 render 内不可调 Date.now()，但格式化给定时间戳是安全的（配合 suppressHydrationWarning）。
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
