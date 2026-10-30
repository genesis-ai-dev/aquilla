// AQU-981: the bulk recordings upload's banner. Mirrors
// CompletionBulkProgressBanner (itself a mirror of AudioBulkProgressBanner):
// a bar with a count and a stop button while it runs, then an honest summary —
// how many uploaded, how many failed and why (behind "Show which"), and how
// many were never started if the person stopped it.

import { useState } from "react"
import { AlertTriangle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  cancelBulkUpload,
  dismissBulkUpload,
  retryFailedBulkUploads,
  useBulkUploadState,
  type BulkFailureCode,
} from "@/lib/audio/bulk-upload/engine"
import { takesSentence } from "@/lib/audio/bulk-upload/takes-summary"

const FAILURE_KEY: Record<BulkFailureCode, MessageKey> = {
  offline: "recordingsUpload.failures.offline",
  network: "recordingsUpload.failures.network",
  server: "recordingsUpload.failures.server",
  refused: "recordingsUpload.failures.refused",
  tooShort: "recordingsUpload.failures.tooShort",
  decode: "recordingsUpload.failures.decode",
  other: "recordingsUpload.failures.other",
}

export function RecordingsUploadBanner() {
  const t = useT()
  const { locale } = useI18n()
  const state = useBulkUploadState()
  const [showFailures, setShowFailures] = useState(false)
  if (!state) return null
  const fmt = (n: number) => formatNumber(n, locale)
  const { total, done, failed, notStarted, cancelled, waitingForConnection, finished, takes } = state
  // Files, like `total` and `done`: a failed verse in parts is one failure
  // but several files.
  const failedFiles = failed.reduce((n, f) => n + f.files, 0)

  const dismiss = (
    <AppTooltip content={t("common.dismiss")}>
      <Button type="button" variant="ghost" size="icon-xs" onClick={dismissBulkUpload} aria-label={t("common.dismiss")} className="ms-1 text-muted-foreground">
        <X />
      </Button>
    </AppTooltip>
  )

  if (finished) {
    const problem = failed.length > 0 || cancelled
    return (
      <>
        <div
          className={`flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-sm ${problem ? "border-destructive/40" : ""}`}
          data-testid="recordings-banner"
          data-state="finished"
        >
          {problem && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
          <span data-testid="recordings-banner-text">
            {cancelled
              ? t("recordingsUpload.banner.stoppedSummary", { done: fmt(done), total: fmt(total), notStarted: fmt(notStarted) })
              : t("recordingsUpload.banner.done", { count: fmt(done) })}
            {takes.length > 0 && <> {takesSentence(t, locale, takes)}</>}
            {failed.length > 0 && (
              <> {t("recordingsUpload.banner.failedSummary", { failed: fmt(failedFiles), total: fmt(total) })}</>
            )}
          </span>
          {failed.length > 0 && (
            <>
              <Button type="button" size="xs" variant="outline" onClick={() => setShowFailures(true)} data-testid="recordings-show-failures">
                {t("recordingsUpload.banner.showFailures")}
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={() => void retryFailedBulkUploads()} data-testid="recordings-retry">
                {t("recordingsUpload.banner.tryAgain")}
              </Button>
            </>
          )}
          <div className="flex-1" />
          {dismiss}
        </div>
        <Dialog open={showFailures} onOpenChange={setShowFailures}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{t("recordingsUpload.failures.title")}</DialogTitle>
              <DialogDescription>{t("recordingsUpload.failures.description")}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <ul className="max-h-80 divide-y overflow-y-auto rounded-md border text-xs" data-testid="recordings-failures">
                {failed.map((f) => (
                  <li key={f.index} className="flex flex-col gap-0.5 px-3 py-2">
                    <span className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                      <span className="shrink-0 font-mono text-muted-foreground">{f.target}</span>
                    </span>
                    <span className="text-muted-foreground">{t(FAILURE_KEY[f.code], { message: f.message })}</span>
                  </li>
                ))}
              </ul>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowFailures(false)}>{t("common.close")}</Button>
              <Button onClick={() => { setShowFailures(false); void retryFailedBulkUploads() }}>{t("recordingsUpload.banner.tryAgain")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  const settled = done + failedFiles
  const pct = total > 0 ? Math.round((settled / total) * 100) : 0
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm" data-testid="recordings-banner" data-state="running">
      <span className="font-medium">{t("recordingsUpload.banner.uploading")}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-muted-foreground" data-testid="recordings-banner-count">
        {fmt(settled)}/{fmt(total)}
      </span>
      {waitingForConnection && !cancelled && (
        <span className="text-muted-foreground" data-testid="recordings-banner-waiting">{t("recordingsUpload.banner.waiting")}</span>
      )}
      {!cancelled ? (
        <AppTooltip content={t("recordingsUpload.banner.stop")}>
          <Button type="button" variant="ghost" size="icon-xs" onClick={cancelBulkUpload} aria-label={t("recordingsUpload.banner.stop")} className="ms-1 text-muted-foreground" data-testid="recordings-banner-stop">
            <X />
          </Button>
        </AppTooltip>
      ) : (
        <span className="text-muted-foreground">{t("common.cancelling")}</span>
      )}
    </div>
  )
}
