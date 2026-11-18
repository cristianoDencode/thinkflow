import { memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { extractSqlBlocks, normalizeDiagrams, type SqlBlock } from '@thinkflow/shared';
import { SqlCodeBlock, type SqlCodeActions } from '../data-ai/sql-code-block';
import { SafeMermaidBlock } from './mermaid-block';
import { remarkMermaid } from './remark-mermaid';

/** Offset of the opening fence of a rendered `<pre>` (react-markdown hands over its hast node). */
function offsetOf(node: unknown): number | null {
  const offset = (node as { position?: { start?: { offset?: number } } } | undefined)?.position
    ?.start?.offset;
  return typeof offset === 'number' ? offset : null;
}

function blockAt(blocks: SqlBlock[], node: unknown): SqlBlock | undefined {
  const offset = offsetOf(node);
  // the fence may be indented up to 3 spaces
  return offset === null
    ? undefined
    : blocks.find((b) => offset >= b.start && offset <= b.start + 3);
}

export const Markdown = memo(function Markdown({
  content,
  streaming = false,
  codeActions,
}: {
  content: string;
  streaming?: boolean;
  /**
   * Opt-in ("Dados com IA"): SQL blocks get a validation badge plus "Rodar"/"Copiar" buttons.
   * Without it the Markdown renders exactly as in the chat.
   */
  codeActions?: SqlCodeActions;
}) {
  const normalized = useMemo(() => normalizeDiagrams(content).text, [content]);
  const sqlBlocks = useMemo(
    () => (codeActions ? extractSqlBlocks(normalized) : []),
    [codeActions, normalized],
  );
  return (
    <div className="prose-tf text-[15px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMermaid]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          ...(codeActions && sqlBlocks.length > 0
            ? {
                pre: ({ node, ...props }: { node?: unknown; children?: ReactNode }) => {
                  const block = blockAt(sqlBlocks, node);
                  const pre = <pre {...props} />;
                  return block ? (
                    <SqlCodeBlock
                      sql={block.sql}
                      index={block.index}
                      actions={codeActions}
                      streaming={streaming}
                    >
                      {pre}
                    </SqlCodeBlock>
                  ) : (
                    pre
                  );
                },
              }
            : {}),
          div: ({ node: _node, ...props }) => {
            const code = (props as Record<string, unknown>)['data-mermaid'];
            return typeof code === 'string' ? (
              <SafeMermaidBlock code={code} streaming={streaming} />
            ) : (
              <div {...props} />
            );
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});
