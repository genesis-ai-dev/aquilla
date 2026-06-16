/**
 * ChatMarkdown.tsx — chat UX improvements
 *
 * Markdown renderer for assistant chat messages. react-markdown + remark-gfm
 * render to React elements (no dangerouslySetInnerHTML). Deliberately scoped
 * to chat — other surfaces (e.g. TranslationNotesSidebar) stay markdown-free.
 */

import { useRef, useState, type ReactNode, type ComponentProps } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Copy, Check } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    const text = preRef.current?.textContent ?? ""
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable — nothing to surface here.
    }
  }

  return (
    <div className="group/code relative">
      <pre
        ref={preRef}
        className="overflow-x-auto rounded-md border bg-background/70 p-2 font-mono text-[0.9em] leading-relaxed"
      >
        {children}
      </pre>
      <AppTooltip content="Copy code">
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label="Copy code"
          className={cn(
            "absolute right-1 top-1 rounded border bg-background p-1 text-muted-foreground",
            "opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100",
          )}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </AppTooltip>
    </div>
  )
}

const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  h1: ({ children }) => <h1 className="mb-1 mt-2 text-[1.1em] font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2 text-[1.05em] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h4>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) => (
    <code className={cn("rounded bg-background/70 px-1 py-0.5 font-mono text-[0.9em]", className)}>
      {children}
    </code>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border pl-2 text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-[0.95em]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/60 px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
  hr: () => <hr className="my-2 border-border" />,
}

export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
