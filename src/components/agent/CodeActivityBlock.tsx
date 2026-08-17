/**
 * CodeActivityBlock.tsx — one `run_code` sandbox call in the run timeline
 * (AQU-AGENT §2/§4: tool.code.start / tool.code.output).
 *
 * Collapsed by default like ToolChip in AgentRunView: language chip + a
 * truncated one-line preview + a running spinner or elapsed time. Expanding
 * shows the full code preview and, once settled, stdout/stderr with a
 * truncation notice when the sandbox capped output at 64KB.
 */

import { useState } from "react"
import { ChevronRight, TerminalSquare } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import type { CodeActivityItem } from "@/lib/agent/run-state"

export function CodeActivityBlock({ item }: { item: CodeActivityItem }) {
  const [open, setOpen] = useState(false)
  const settled = item.durationMs !== undefined
  const hasOutput = Boolean(item.stdout) || Boolean(item.stderr)

  return (
    <div
      data-frame-type={settled ? "tool.code.output" : "tool.code.start"}
      className="rounded-md border bg-muted/30"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-start text-[11px]"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <TerminalSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
        <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
          {item.language}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{item.codePreview}</span>
        {settled ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.durationMs}ms</span>
        ) : (
          <Spinner className="size-3 shrink-0 text-muted-foreground" aria-label="Code running" />
        )}
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-2 py-1.5">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed">
            {item.codePreview}
          </pre>
          {settled ? (
            <>
              {item.stdout ? (
                <div>
                  <div className="text-[10px] font-medium text-muted-foreground">stdout</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed">
                    {item.stdout}
                  </pre>
                </div>
              ) : null}
              {item.stderr ? (
                <div>
                  <div className="text-[10px] font-medium text-destructive">stderr</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-destructive">
                    {item.stderr}
                  </pre>
                </div>
              ) : null}
              {!hasOutput && <div className="text-[10px] italic text-muted-foreground">(no output)</div>}
              {item.truncated && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                  Output truncated — the sandbox caps stdout/stderr at 64KB each.
                </div>
              )}
            </>
          ) : (
            <div className="text-[10px] italic text-muted-foreground">Running…</div>
          )}
        </div>
      )}
    </div>
  )
}
