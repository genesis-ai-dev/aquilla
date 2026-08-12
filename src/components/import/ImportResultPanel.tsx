import { useState } from "react"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"

interface ImportResultPanelProps {
  importedCount: number
  skipped: { book: string; reason: string }[]
  onDismiss: () => void | Promise<void>
  error?: string | null
}

export function ImportResultPanel({ importedCount, skipped, onDismiss, error }: ImportResultPanelProps) {
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  const reportText = [
    `Import complete: ${importedCount} item${importedCount === 1 ? "" : "s"} imported, ${skipped.length} skipped.`,
    "",
    "Skipped items:",
    ...skipped.map((s) => `  ${s.book}: ${s.reason}`),
  ].join("\n")

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(reportText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard not available — ignore
    }
  }

  async function handleDismiss() {
    if (dismissing) return
    setDismissing(true)
    try {
      await onDismiss()
    } finally {
      setDismissing(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{importedCount}</span> item{importedCount === 1 ? "" : "s"} imported
        successfully; <span className="font-medium text-amber-600">{skipped.length}</span> could not be imported.
        Review the list below and copy it before closing.
      </p>
      <ScrollArea className="h-56 rounded-md border bg-muted/30 p-3">
        <ul className="space-y-1">
          {skipped.map((s, i) => (
            <li key={i} className="text-xs">
              <span className="font-medium">{s.book}</span>
              <span className="text-muted-foreground"> — {s.reason}</span>
            </li>
          ))}
        </ul>
      </ScrollArea>
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      <div className="flex justify-between gap-2">
        <Button variant="outline" size="sm" onClick={handleCopy} disabled={dismissing}>
          {copied ? "Copied!" : "Copy report"}
        </Button>
        <Button size="sm" onClick={handleDismiss} disabled={dismissing}>
          {dismissing ? "Closing…" : "Close"}
        </Button>
      </div>
    </div>
  )
}
