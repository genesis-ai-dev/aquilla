/**
 * AQU-307 / AQU-1028: the in-app feedback dialog — three short answers,
 * auto-captured context, and an optional image.
 *
 * AQU-2467 split the one text box into "What happened?" (required), "What were
 * you trying to do?" and "What did you expect to happen?", and replaced the
 * one-click page grab with a screenshot the user controls: the dialog hides,
 * the browser's picker opens, and the captured frame comes back in a crop view.
 * "Attach an image" takes a file from the device instead, sent as-is.
 *
 * Opened from HelpMenu's Feedback item (AQU-1548 folded the shell footer's
 * standalone FeedbackButton back into that menu).
 *
 * AQU-1028 changed where a report goes. AQU-307 shipped it as a PostHog capture,
 * which meant the message only reached the team when the user had analytics
 * consent ON — and the stuck, frustrated user this exists for is exactly the one
 * least likely to have opted in. The report now always POSTs to the identity
 * worker (`/api/v2/feedback`), which posts it to the team's private Discord channel. Consent still governs
 * one thing, and the copy says only that: whether a session-replay link rides
 * along.
 *
 * "Copy report" survives as the fallback for a failed send (offline, 502) rather
 * than as the consent-off branch.
 */

import { useCallback, useRef, useState } from "react"
import { useLocation, useParams } from "react-router-dom"
import { Camera, ImagePlus, X } from "lucide-react"
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
  ATTACHABLE_IMAGE_TYPES,
  ScreenshotCancelled,
  captureScreenFrame,
  cropImage,
  isScreenshotCaptureSupported,
  submitFeedback,
  validateAttachedImage,
} from "@/lib/feedback"
import type { Rect } from "@/lib/screenshot-crop"
import { useT } from "@/lib/i18n/I18nProvider"
import { ScreenshotCropper } from "./ScreenshotCropper"

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

  const [whatHappened, setWhatHappened] = useState("")
  const [tryingTo, setTryingTo] = useState("")
  const [expected, setExpected] = useState("")
  const [state, setState] = useState<State>("idle")
  const [attempted, setAttempted] = useState(false)
  const [sendError, setSendError] = useState(false)
  const [delivered, setDelivered] = useState(true)

  const [screenshot, setScreenshot] = useState<Blob | null>(null)
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  // True while the dialog is hidden for the screen picker. It hides through the
  // `open` prop, not handleClose, so the typed answers survive.
  const [capturing, setCapturing] = useState(false)
  const [captureFailed, setCaptureFailed] = useState(false)
  // The full-resolution frame waiting in the crop view.
  const [frame, setFrameState] = useState<{ blob: Blob; url: string } | null>(null)
  const [cropping, setCropping] = useState(false)
  const [imageError, setImageError] = useState<"tooLarge" | "wrongType" | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const context: ReportContext = {
    route: pathname,
    projectId: params.id,
    fileId: params.fileId,
  }
  const whatHappenedError = !whatHappened.trim() ? t("nav.report.whatHappenedRequired") : null
  const canCapture = isScreenshotCaptureSupported()

  const dropScreenshot = useCallback(() => {
    setScreenshot(null)
    setScreenshotUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return null
    })
  }, [])

  const frameUrlRef = useRef<string | null>(null)
  const setFrame = useCallback((blob: Blob | null) => {
    if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current)
    frameUrlRef.current = blob ? URL.createObjectURL(blob) : null
    setFrameState(blob && frameUrlRef.current ? { blob, url: frameUrlRef.current } : null)
  }, [])

  const keepImage = useCallback(
    (blob: Blob) => {
      dropScreenshot()
      setScreenshot(blob)
      setScreenshotUrl(URL.createObjectURL(blob))
    },
    [dropScreenshot],
  )

  const handleCapture = useCallback(async () => {
    setCaptureFailed(false)
    setImageError(null)
    // Hide the dialog first, then let two frames paint so it is gone before the
    // picker opens. The picker call stays inside the click's user-activation window.
    setCapturing(true)
    await new Promise<void>((resolve) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        : resolve(),
    )
    try {
      setFrame(await captureScreenFrame())
    } catch (err) {
      // A dismissed share-picker is a decision, not a fault — say nothing.
      if (!(err instanceof ScreenshotCancelled)) setCaptureFailed(true)
    } finally {
      setCapturing(false)
    }
  }, [setFrame])

  const handleCropConfirm = useCallback(
    async (rect: Rect | null) => {
      if (!frame) return
      setCropping(true)
      try {
        keepImage(await cropImage(frame.blob, rect))
        setFrame(null)
      } catch {
        setFrame(null)
        setCaptureFailed(true)
      } finally {
        setCropping(false)
      }
    },
    [frame, keepImage, setFrame],
  )

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset so choosing the same file again after an error still fires.
    e.target.value = ""
    if (!file) return
    setCaptureFailed(false)
    const verdict = validateAttachedImage(file)
    if (verdict !== "ok") {
      setImageError(verdict)
      return
    }
    setImageError(null)
    keepImage(file)
  }

  async function handleSubmit() {
    setAttempted(true)
    if (whatHappenedError || state === "sending") return

    const replayUrl = getSessionReplayUrl()
    setSendError(false)
    setState("sending")
    try {
      // Read the session at submit time rather than through useAccounts: this
      // dialog is mounted by the always-present shell Help menu, and a hook
      // into the accounts query would make every surface that renders the
      // shell depend on a QueryClientProvider just to keep a closed dialog alive.
      const session = await loadActiveSession()
      const result = await submitFeedback(session?.jwt ?? "", {
        whatHappened: whatHappened.trim(),
        tryingTo: tryingTo.trim(),
        expected: expected.trim(),
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
        whatHappened: whatHappened.trim(),
        tryingTo: tryingTo.trim(),
        expected: expected.trim(),
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
    if (whatHappenedError) return
    const text = buildReportText({
      whatHappened: whatHappened.trim(),
      tryingTo: tryingTo.trim(),
      expected: expected.trim(),
      context,
      hasScreenshot: screenshot !== null,
    })
    void navigator.clipboard.writeText(text)
    setState("copied")
  }

  function handleClose() {
    // Reset state on close so the dialog is fresh next time
    setWhatHappened("")
    setTryingTo("")
    setExpected("")
    setFrame(null)
    setImageError(null)
    setState("idle")
    setAttempted(false)
    setSendError(false)
    setDelivered(true)
    setCaptureFailed(false)
    dropScreenshot()
    onOpenChange(false)
  }

  return (
    <Dialog open={open && !capturing} onOpenChange={handleClose}>
      <DialogContent className={frame ? "max-w-3xl" : "max-w-md"}>
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
        ) : frame ? (
          <ScreenshotCropper
            imageUrl={frame.url}
            busy={cropping}
            onConfirm={(rect) => void handleCropConfirm(rect)}
            onDiscard={() => setFrame(null)}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2 py-1">
              <Field data-invalid={attempted && !!whatHappenedError}>
                <FieldLabel htmlFor="report-problem-what-happened">
                  {t("nav.report.whatHappenedLabel")}
                </FieldLabel>
                <Textarea
                  id="report-problem-what-happened"
                  rows={3}
                  value={whatHappened}
                  onChange={(e) => setWhatHappened(e.target.value)}
                  className="resize-none"
                  aria-invalid={attempted && !!whatHappenedError}
                />
                {attempted && whatHappenedError && <FieldError>{whatHappenedError}</FieldError>}
              </Field>

              <Field>
                <FieldLabel htmlFor="report-problem-trying-to">
                  {t("nav.report.tryingToLabel")}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    {t("nav.report.optional")}
                  </span>
                </FieldLabel>
                <Textarea
                  id="report-problem-trying-to"
                  rows={2}
                  value={tryingTo}
                  onChange={(e) => setTryingTo(e.target.value)}
                  className="resize-none"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="report-problem-expected">
                  {t("nav.report.expectedLabel")}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    {t("nav.report.optional")}
                  </span>
                </FieldLabel>
                <Textarea
                  id="report-problem-expected"
                  rows={2}
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  className="resize-none"
                />
              </Field>

              <div className="flex flex-col gap-2">
                {screenshotUrl && (
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
                      size="icon-sm"
                      aria-label={t("nav.report.removeScreenshot")}
                      onClick={dropScreenshot}
                    >
                      <X />
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {canCapture && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleCapture()}
                    >
                      <Camera />
                      {t("nav.report.takeScreenshot")}
                    </Button>
                  )}
                  {/* Always offered, also where screen capture is unsupported. */}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlus />
                    {t("nav.report.attachImage")}
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ATTACHABLE_IMAGE_TYPES.join(",")}
                    className="hidden"
                    data-testid="report-image-input"
                    onChange={handleFileChosen}
                  />
                </div>
                {captureFailed && (
                  <p className="text-xs text-destructive">{t("nav.report.screenshotFailed")}</p>
                )}
                {imageError && (
                  <p className="text-xs text-destructive" role="alert">
                    {imageError === "tooLarge"
                      ? t("nav.report.imageTooLarge")
                      : t("nav.report.imageWrongType")}
                  </p>
                )}
              </div>

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
