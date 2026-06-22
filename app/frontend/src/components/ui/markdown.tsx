import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders LLM markdown (bold, lists, headings, tables) as themed prose instead
 * of leaking raw `*`/`**`/`#` characters. Styling is driven by CIQ theme tokens
 * so it follows light/dark automatically.
 */
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
    return (
        <div className={`ciq-md text-sm leading-relaxed text-[color:var(--ciq-text-body)] ${className}`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    h1: ({ children }) => (
                        <h3 className="mb-2 mt-3 font-display text-base font-bold text-[color:var(--ciq-text-strong)] first:mt-0">{children}</h3>
                    ),
                    h2: ({ children }) => (
                        <h4 className="mb-2 mt-3 font-display text-[15px] font-bold text-[color:var(--ciq-text-strong)] first:mt-0">{children}</h4>
                    ),
                    h3: ({ children }) => <h5 className="mb-1.5 mt-2.5 text-sm font-semibold text-[color:var(--ciq-text-strong)] first:mt-0">{children}</h5>,
                    p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
                    strong: ({ children }) => <strong className="font-semibold text-[color:var(--ciq-text-strong)]">{children}</strong>,
                    em: ({ children }) => <em className="italic">{children}</em>,
                    ul: ({ children }) => <ul className="mb-2.5 ml-1 space-y-1.5 last:mb-0">{children}</ul>,
                    ol: ({ children }) => <ol className="mb-2.5 ml-5 list-decimal space-y-1.5 last:mb-0">{children}</ol>,
                    li: ({ children }) => (
                        <li className="relative pl-5 marker:hidden before:absolute before:left-0 before:top-[0.55em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-[color:var(--ciq-accent-purple)]">
                            {children}
                        </li>
                    ),
                    a: ({ href, children }) => (
                        <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-[color:var(--ciq-accent-blue)] underline underline-offset-2"
                        >
                            {children}
                        </a>
                    ),
                    blockquote: ({ children }) => (
                        <blockquote className="my-2.5 border-l-2 border-[color:var(--ciq-accent-purple)] pl-3 italic text-[color:var(--ciq-text-muted)]">
                            {children}
                        </blockquote>
                    ),
                    code: ({ children }) => (
                        <code className="rounded bg-[color:var(--ciq-tile-strong)] px-1.5 py-0.5 font-mono text-[0.85em] text-[color:var(--ciq-text-strong)]">
                            {children}
                        </code>
                    ),
                    hr: () => <hr className="my-3 border-[color:var(--ciq-line)]" />,
                    table: ({ children }) => (
                        <div className="my-2.5 overflow-x-auto">
                            <table className="w-full border-collapse text-xs">{children}</table>
                        </div>
                    ),
                    th: ({ children }) => (
                        <th className="border border-[color:var(--ciq-line)] bg-[color:var(--ciq-tile)] px-2.5 py-1.5 text-left font-semibold text-[color:var(--ciq-text-strong)]">
                            {children}
                        </th>
                    ),
                    td: ({ children }) => <td className="border border-[color:var(--ciq-line)] px-2.5 py-1.5">{children}</td>
                }}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
}
