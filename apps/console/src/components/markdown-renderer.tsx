import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownRenderer({
  children,
}: {
  readonly children: string;
}) {
  return <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>;
}
