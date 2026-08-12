import { useState } from "react"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

interface ImportResultPanelProps {
  importedCount: number
  skipped: { book: string; reason: string }[]
  onDismiss: () => void | Promise<void>
  error?: string | null
}

export function ImportResultPanel({ importedCount, skipped, onDismiss, error }: ImportResultPanelProps) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  // Two independent counts (imported vs. skipped) can't share one plural
  // template — English "1 item imported, 2 skipped" hides that "item" and
  // "skipped" each agree with a different number, which breaks for a locale
  // with real plural agreement. Resolved as two separately-pluralized
  // sub-phrases and interpolated into the header, so each stays grammatical.
  const importedPhrase = t("importExport.result.reportImportedCount", { count: importedCount })
  const skippedPhrase = t("importExport.result.reportSkippedCount", { count: skipped.length })
  const reportText = [
    t("importExport.result.reportHeader", { imported: importedPhrase, skipped: skippedPhrase }),
    "",
    t("importExport.result.reportSkippedListLabel"),
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
        <RichMessage
          k="importExport.result.summaryImported"
          count={importedCount}
          values={{ count: <span className="font-medium text-foreground">{importedCount}</span> }}
        />{" "}
        <RichMessage
          k="importExport.result.summarySkipped"
          values={{ count: <span className="font-medium text-amber-600">{skipped.length}</span> }}
        />{" "}
        {t("importExport.result.summaryReviewHint")}
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
          {copied ? t("importExport.result.copied") : t("importExport.result.copyReport")}
        </Button>
        <Button size="sm" onClick={handleDismiss} disabled={dismissing}>
          {dismissing ? t("importExport.result.closing") : t("common.close")}
        </Button>
      </div>
    </div>
  )
}
