/**
 * AQU-307: Dialog for "Report a problem" — free-text + auto-captured context.
 * Opened from HelpMenu's Report item.
 *
 * Consent-aware:
 * - If analytics are ON  → submits PostHog event (with session replay URL if available).
 * - If analytics are OFF → shows honest message, still lets user copy the report text.
 */

import { useState } from "react"
import { useLocation, useParams } from "react-router-dom"
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
import {
  captureReportProblem,
  buildReportText,
  getSessionReplayUrl,
  type ReportContext,
} from "@/lib/report-problem"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type State = "idle" | "submitted" | "copied"

export function ReportProblemDialog({ open, onOpenChange }: Props) {
  const t = useT()
  const { pathname } = useLocation()
  // Route-level params — may be undefined on non-project pages
  const params = useParams<{ id?: string; fileId?: string }>()
  const { enabled: analyticsEnabled } = useAnalyticsConsent()

  const [description, setDescription] = useState("")
  const [state, setState] = useState<State>("idle")
  const [attempted, setAttempted] = useState(false)

  const context: ReportContext = {
    route: pathname,
    projectId: params.id,
    fileId: params.fileId,
  }
  const descriptionError = !description.trim() ? t("nav.report.descriptionRequired") : null

  function handleSubmit() {
    setAttempted(true)
    if (descriptionError) return

    const replayUrl = getSessionReplayUrl()
    captureReportProblem({ description: description.trim(), context, sessionReplayUrl: replayUrl })
    setState("submitted")
  }

  function handleCopy() {
    setAttempted(true)
    if (descriptionError) return
    const text = buildReportText({ description: description.trim(), context })
    void navigator.clipboard.writeText(text)
    setState("copied")
  }

  function handleClose() {
    // Reset state on close so the dialog is fresh next time
    setDescription("")
    setState("idle")
    setAttempted(false)
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
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              {analyticsEnabled ? (
                <Button
                  onClick={handleSubmit}
                  className="w-full sm:w-auto"
                >
                  {t("nav.report.sendReport")}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={handleCopy}
                  className="w-full sm:w-auto"
                >
                  {state === "copied" ? t("nav.report.copied") : t("nav.report.copyReport")}
                </Button>
              )}
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
