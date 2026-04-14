import { X, User, Bot, Check, BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import { cn } from "@/lib/utils"

interface HistoryDrawerProps {
  cell: CellData
  onClose: () => void
}

export function HistoryDrawer({ cell, onClose }: HistoryDrawerProps) {
  const history = cell.history || []
  // Most recent first
  const reversed = [...history].slice().reverse()

  function formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <div className="flex h-full w-96 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-semibold">
          Edit history {cell.context && <span className="text-muted-foreground">· {cell.context}</span>}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border-b px-3 py-2 text-xs">
        <div className="text-muted-foreground">Source</div>
        <div className="mt-0.5">{cell.original}</div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">No edits yet.</p>
        ) : (
          <>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {history.length} revision{history.length !== 1 ? "s" : ""}
            </p>
            <ol className="space-y-2">
              {reversed.map((entry, i) => {
                const isCurrent = i === 0
                const Icon = entry.source === "llm" ? Bot : User
                const sourceColor =
                  entry.source === "llm"
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                    : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                const validatedColor = entry.validated
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"

                return (
                  <li
                    key={`${entry.timestamp}-${i}`}
                    className={cn(
                      "rounded border p-2 text-sm",
                      isCurrent ? "border-primary/40 bg-primary/5" : ""
                    )}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
                      <span className={cn("flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium", sourceColor)}>
                        <Icon className="h-3 w-3" />
                        {entry.source}
                      </span>
                      <span className={cn("flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium", validatedColor)}>
                        {entry.validated ? <Check className="h-3 w-3" /> : null}
                        {entry.validated ? "validated" : "unvalidated"}
                      </span>
                      <span className="ml-auto text-muted-foreground">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      by <span className="font-medium">{entry.author}</span>
                      {isCurrent && <span className="ml-1.5 text-primary">· current</span>}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
                      {entry.value || <span className="italic text-muted-foreground">(empty)</span>}
                    </div>
                    {entry.examples && entry.examples.length > 0 && (
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <BookOpen className="h-3 w-3" />
                        {entry.examples.length} example{entry.examples.length !== 1 ? "s" : ""} used
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </div>
    </div>
  )
}
