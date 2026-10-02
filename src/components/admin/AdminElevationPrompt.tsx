import { useCallback, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { AdminElevationGate } from "@/components/admin/AdminElevationGate"
import {
  clearElevationRequired,
  isElevationRequired,
  onElevationRequired,
} from "@/lib/errors/elevation-required-signal"
import { useFrontierSession } from "@/hooks/useFrontierSession"

/**
 * AQU-1322: global admin step-up dialog.
 *
 * Opens when a fetch helper raises the elevation-required signal (a platform
 * admin changed membership somewhere they do not belong, and the auth-worker
 * answered 403 "elevation required"). Reuses AdminElevationGate for the emailed
 * code. After a successful verify it only confirms: it does not replay the
 * failed request, so the admin repeats the change by hand.
 *
 * Renders nothing and makes no request until the signal fires, so ordinary
 * users never touch the admin endpoints.
 */
export function AdminElevationPrompt() {
  const required = useSyncExternalStore(onElevationRequired, isElevationRequired)
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [verified, setVerified] = useState(false)

  const close = useCallback(() => {
    setVerified(false)
    clearElevationRequired()
  }, [])

  if (!required || !jwt) return null

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={!verified} className="sm:max-w-md">
        <DialogTitle className="sr-only">Admin verification</DialogTitle>
        {verified ? (
          <div className="space-y-4 py-2 text-center">
            <p className="text-sm">Verified. Try again.</p>
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
