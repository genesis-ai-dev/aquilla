/**
 * AQU-307 / AQU-1028: the in-app feedback dialog — free text, auto-captured
 * context, and an optional screenshot.
 *
 * Opened from HelpMenu's Report item and from the always-visible FeedbackButton
 * in the shell footer.
 *
 * AQU-1028 changed where a report goes. AQU-307 shipped it as a PostHog capture,
 * which meant the message only reached the team when the user had analytics
 * consent ON — and the stuck, frustrated user this exists for is exactly the one
 * least likely to have opted in. The report now always POSTs to the identity
 * worker (`/api/v2/feedback`), which emails the team inbox. Consent still governs
 * one thing, and the copy says only that: whether a session-replay link rides
 * along.
 *
 * "Copy report" survives as the fallback for a failed send (offline, 502) rather
 * than as the consent-off branch.
 */

import { useCallback, useState } from "react"
import { useLocation, useParams } from "react-router-dom"
import { Camera, Loader2, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import { loadActiveSession } from "@/lib/frontier/session-store"
import {
  captureReportProblem,
  buildReportText,
  getSessionReplayUrl,
  type ReportContext,
} from "@/lib/report-problem"
import {
  ScreenshotCancelled,
  captureViewportScreenshot,
  isScreenshotCaptureSupported,
  submitFeedback,
} from "@/lib/feedback"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type State = "idle" | "sending" | "submitted" | "copied"

export function ReportProblemDialog({ open, onOpenChange }: Props) {
  const t = useT()
  const { pathname } = useLocation()
  // Route-level params — may be undefined on non-project pages
  const params = useParams<{ id?: string; fileId?: string }>()
  const { enabled: analyticsEnabled } = useAnalyticsConsent()

  const [description, setDescription] = useState("")
  const [state, setState] = useState<State>("idle")
  const [attempted, setAttempted] = useState(false)
  const [sendError, setSendError] = useState(false)
  const [delivered, setDelivered] = useState(true)

  const [screenshot, setScreenshot] = useState<Blob | null>(null)
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureFailed, setCaptureFailed] = useState(false)

  const context: ReportContext = {
    route: pathname,
    projectId: params.id,
    fileId: params.fileId,
  }
  const descriptionError = !description.trim() ? t("nav.report.descriptionRequired") : null
  const canCapture = isScreenshotCaptureSupported()

  const dropScreenshot = useCallback(() => {
    setScreenshot(null)
    setScreenshotUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return null
    })
  }, [])

  const handleCapture = useCallback(async () => {
    setCaptureFailed(false)
    setCapturing(true)
    try {
      const blob = await captureViewportScreenshot()
      dropScreenshot()
      setScreenshot(blob)
      setScreenshotUrl(URL.createObjectURL(blob))
    } catch (err) {
      // A dismissed share-picker is a decision, not a fault — say nothing.
      if (!(err instanceof ScreenshotCancelled)) setCaptureFailed(true)
    } finally {
      setCapturing(false)
    }
  }, [dropScreenshot])

  async function handleSubmit() {
    setAttempted(true)
    if (descriptionError || state === "sending") return

    const replayUrl = getSessionReplayUrl()
    setSendError(false)
    setState("sending")
    try {
      // Read the session at submit time rather than through useAccounts: this
      // dialog is mounted by the always-present shell FeedbackButton, and a
      // hook into the accounts query would make every surface that renders the
      // shell depend on a QueryClientProvider just to keep a closed dialog alive.
      const session = await loadActiveSession()
      const result = await submitFeedback(session?.jwt ?? "", {
        description: description.trim(),
        route: context.route,
        projectId: context.projectId,
        fileId: context.fileId,
        sessionReplayUrl: replayUrl,
        screenshot,
      })
      setDelivered(result.delivered)
      // Secondary signal only — the report already reached the team above, so a
      // consent-off user is no longer a silent one.
      captureReportProblem({
        description: description.trim(),
        context,
        sessionReplayUrl: replayUrl,
        hasScreenshot: screenshot !== null,
      })
      setState("submitted")
    } catch {
      setSendError(true)
      setState("idle")
    }
  }

  function handleCopy() {
    setAttempted(true)
    if (descriptionError) return
    const text = buildReportText({
      description: description.trim(),
      context,
      hasScreenshot: screenshot !== null,
    })
    void navigator.clipboard.writeText(text)
    setState("copied")
  }

  function handleClose() {
    // Reset state on close so the dialog is fresh next time
    setDescription("")
    setState("idle")
    setAttempted(false)
    setSendError(false)
    setDelivered(true)
    setCaptureFailed(false)
    dropScreenshot()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("nav.report.title")}</DialogTitle>
          <DialogDescription>
            {analyticsEnabled
              ? t("nav.report.descriptionEnabled")
              : t("nav.report.descriptionDisabled")}
          </DialogDescription>
        </DialogHeader>

        {state === "submitted" ? (
          <div className="space-y-3 py-2 text-sm text-muted-foreground">
            <p>{t("nav.report.thanks")}</p>
            {getSessionReplayUrl() && (
              <p className="text-xs">{t("nav.report.replayLinked")}</p>
            )}
            {!delivered && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                {t("nav.report.notDelivered")}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 py-1">
              <Field data-invalid={attempted && !!descriptionError}>
                <FieldLabel htmlFor="report-problem-description" className="sr-only">
                  {t("nav.report.descriptionFieldLabel")}
                </FieldLabel>
                <Textarea
                  id="report-problem-description"
                  placeholder={t("nav.report.placeholder")}
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="resize-none"
                  aria-invalid={attempted && !!descriptionError}
                />
                {attempted && descriptionError && <FieldError>{descriptionError}</FieldError>}
              </Field>

              {canCapture && (
                <div className="flex flex-col gap-2">
                  {screenshotUrl ? (
                    <div className="flex items-center gap-3 rounded-md border p-2">
                      <img
                        src={screenshotUrl}
                        alt={t("nav.report.screenshotAlt")}
                        className="h-14 w-24 shrink-0 rounded border object-cover"
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {t("nav.report.screenshotAttached")}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleCapture()}
                        disabled={capturing}
                      >
                        {t("nav.report.retakeScreenshot")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("nav.report.removeScreenshot")}
                        onClick={dropScreenshot}
                      >
                        <X />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      onClick={() => void handleCapture()}
                      disabled={capturing}
                    >
                      {capturing ? <Loader2 className="animate-spin" /> : <Camera />}
                      {capturing
                        ? t("nav.report.capturingScreenshot")
                        : t("nav.report.attachScreenshot")}
                    </Button>
                  )}
                  {captureFailed && (
                    <p className="text-xs text-destructive">{t("nav.report.screenshotFailed")}</p>
                  )}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t("nav.report.capturedContext")} <span className="font-mono">{pathname}</span>
                {params.id && (
                  <>
                    {" "}· {t("common.project")} <span className="font-mono">{params.id}</span>
                  </>
                )}
                {params.fileId && (
                  <>
                    {" "}· {t("common.file")} <span className="font-mono">{params.fileId}</span>
                  </>
                )}
              </p>

              {!analyticsEnabled && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                  {t("nav.report.analyticsOffNotice")}
                </p>
              )}

              {sendError && (
                <p className="text-xs text-destructive" role="alert">
                  {t("nav.report.sendFailed")}
                </p>
              )}
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button
                onClick={() => void handleSubmit()}
                disabled={state === "sending"}
                className="w-full sm:w-auto"
              >
                {state === "sending" ? t("nav.report.sending") : t("nav.report.sendReport")}
              </Button>
              {/* Always offered: the report text is useful to paste into Discord
                  or a support thread, and it is the only route left when a send
                  fails. */}
              <Button
                variant="secondary"
                onClick={handleCopy}
                className="w-full sm:w-auto"
              >
                {state === "copied" ? t("nav.report.copied") : t("nav.report.copyReport")}
              </Button>
              <Button variant="ghost" onClick={handleClose} className="w-full sm:w-auto">
                {t("common.cancel")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
