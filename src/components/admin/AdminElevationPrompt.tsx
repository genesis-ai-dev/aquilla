import { useCallback, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { AdminElevationGate } from "@/components/admin/AdminElevationGate"
import {
  clearElevationRequired,
  getElevationWaitingOn,
  onElevationRequired,
  type ElevationWaitingOn,
} from "@/lib/errors/elevation-required-signal"
import { useFrontierSession } from "@/hooks/useFrontierSession"

/** What the "Verified" step says, by what was refused (see the signal's ElevationReason). */
const VERIFIED_COPY: Record<ElevationWaitingOn, string> = {
  action: "Your change wasn't saved yet. Close this and make it again.",
  "sync-token": "The project will reload, and edits waiting to send will go through on their own.",
  both:
    "The project will reload, and edits waiting to send will go through on their own. " +
    "Your other change wasn't saved yet, so close this and make it again.",
}

/**
 * AQU-1322: global admin step-up dialog.
 *
 * Opens when a fetch helper raises the elevation-required signal: a platform
 * admin acted somewhere they do not belong, and the auth-worker answered 403
 * "elevation required". Reuses AdminElevationGate for the emailed code. After a
 * successful verify it only confirms, worded for what was refused:
 * - a membership/admin change: nothing replays it, so the admin makes it again.
 * - a project sync-token mint (OPS-44): held outbox edits resend on their own
 *   and ProjectElevationBoundary reloads the project's pages, so there is
 *   nothing to redo.
 *
 * Renders nothing and makes no request until the signal fires, so ordinary
 * users never touch the admin endpoints.
 */
export function AdminElevationPrompt() {
  const waitingOn = useSyncExternalStore(onElevationRequired, getElevationWaitingOn)
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [verified, setVerified] = useState(false)

  const close = useCallback(() => {
    setVerified(false)
    clearElevationRequired()
  }, [])

  if (!waitingOn || !jwt) return null

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={!verified} className="sm:max-w-md">
        <DialogTitle className="sr-only">Admin verification</DialogTitle>
        {verified ? (
          <div className="space-y-4 py-2 text-center">
            <h2 className="font-heading text-lg font-medium">Verified</h2>
            <p className="text-sm text-muted-foreground">{VERIFIED_COPY[waitingOn]}</p>
            <Button type="button" onClick={close}>
              Close
            </Button>
          </div>
        ) : (
          <AdminElevationGate
            jwt={jwt}
            email={null}
            onElevated={() => setVerified(true)}
            description="This needs your admin code. We'll email it to your company address."
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
