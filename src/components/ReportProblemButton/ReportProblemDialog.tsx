/**
 * FRO-307: Dialog for "Report a problem" — free-text + auto-captured context.
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
import { Textarea } from "@/components/ui/textarea"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"
import {
  captureReportProblem,
  buildReportText,
  getSessionReplayUrl,
  type ReportContext,
} from "@/lib/report-problem"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type State = "idle" | "submitted" | "copied"

export function ReportProblemDialog({ open, onOpenChange }: Props) {
  const { pathname } = useLocation()
  // Route-level params — may be undefined on non-project pages
  const params = useParams<{ id?: string; fileId?: string }>()
  const { enabled: analyticsEnabled } = useAnalyticsConsent()

  const [description, setDescription] = useState("")
  const [state, setState] = useState<State>("idle")

  const context: ReportContext = {
    route: pathname,
    projectId: params.id,
    fileId: params.fileId,
  }

  function handleSubmit() {
    if (!description.trim()) return

    const replayUrl = getSessionReplayUrl()
    captureReportProblem({ description: description.trim(), context, sessionReplayUrl: replayUrl })
    setState("submitted")
  }

  function handleCopy() {
    const text = buildReportText({ description: description.trim(), context })
    void navigator.clipboard.writeText(text)
    setState("copied")
  }

  function handleClose() {
    // Reset state on close so the dialog is fresh next time
    setDescription("")
    setState("idle")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Report a problem</DialogTitle>
          <DialogDescription>
            {analyticsEnabled
              ? "Describe what went wrong. Your report will be sent along with session context."
              : "Analytics are off — your report won't be sent automatically. You can copy it to share manually."}
          </DialogDescription>
        </DialogHeader>

        {state === "submitted" ? (
          <div className="space-y-3 py-2 text-sm text-muted-foreground">
            <p>Thanks — report received.</p>
            {getSessionReplayUrl() && (
              <p className="text-xs">Session replay linked to the report.</p>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-2 py-1">
              <Textarea
                placeholder="What went wrong?"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Captured context: <span className="font-mono">{pathname}</span>
                {params.id && (
                  <>
                    {" "}· project <span className="font-mono">{params.id}</span>
                  </>
                )}
                {params.fileId && (
                  <>
                    {" "}· file <span className="font-mono">{params.fileId}</span>
                  </>
                )}
              </p>

              {!analyticsEnabled && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                  Usage data collection is off. Enable it in Preferences if you&apos;d like
                  reports to be sent automatically — or use "Copy report" to share it manually.
                </p>
              )}
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              {analyticsEnabled ? (
                <Button
                  onClick={handleSubmit}
                  disabled={!description.trim()}
                  className="w-full sm:w-auto"
                >
                  Send report
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={handleCopy}
                  disabled={!description.trim()}
                  className="w-full sm:w-auto"
                >
                  {state === "copied" ? "Copied!" : "Copy report"}
                </Button>
              )}
              <Button variant="ghost" onClick={handleClose} className="w-full sm:w-auto">
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
