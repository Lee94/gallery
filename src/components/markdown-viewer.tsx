import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// react-markdown 默认不渲染原始 HTML，天然无 XSS 面
export function MarkdownViewer({ content }: { content: string }) {
  return (
    <article className="prose prose-zinc mx-auto w-full max-w-3xl px-6 py-10 dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </article>
  );
}
