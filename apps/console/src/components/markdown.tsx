import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() => import("./markdown-renderer"));

/** Renders public message text as Markdown without enabling raw HTML. */
export function MarkdownContent({ children }: { readonly children: string }) {
  return (
    <div className="msg-body">
      <Suspense fallback={<p>{children}</p>}>
        <MarkdownRenderer>{children}</MarkdownRenderer>
      </Suspense>
    </div>
  );
}
