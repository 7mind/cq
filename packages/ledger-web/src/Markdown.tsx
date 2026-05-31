/**
 * Render a markdown string to sanitized HTML.
 *
 * Field values are arbitrary user/agent content, so output is sanitized with
 * rehype-sanitize (default schema — no raw HTML, safe URLs only). GFM enables
 * tables, task lists, strikethrough, and autolinks.
 */

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

export function Markdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="lw-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
