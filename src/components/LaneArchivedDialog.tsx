/**
 * AQU-1463: the interruption a member gets when the lane they are working in
 * is archived under them.
 *
 * It is deliberately must-dismiss. The member is mid-sentence in a lane that
 * has just stopped accepting writes, and every other way out of a dialog —
 * Esc, a click on the backdrop, the corner X — is the kind of reflex that
 * dismisses a notice without reading it. The acknowledge button is the only
 * exit, so "I did not know" stops being available.
 *
 * It fires once per archive, not once per view: `laneArchiveToAnnounce`
 * (src/lib/lanes/lane-lock.ts) decides who sees it, and a cold open on an
 * already-archived lane gets the read-only banner instead. After dismissal the
 * banner is the standing reminder.
 */

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"

export interface LaneArchivedDialogProps {
  /** The archived lane's label, as the switcher names it. */
  laneLabel: string
  /** Null closes the dialog; the host passes the lock it wants announced. */
  open: boolean
  /** The acknowledge button — the only way this dialog closes. */
  onAcknowledge: () => void
}

export function LaneArchivedDialog({ laneLabel, open, onAcknowledge }: LaneArchivedDialogProps) {
  const t = useT()
  return (
    <Dialog
      open={open}
      // Swallow every close request that is not the acknowledge button. Base UI
      // routes Esc and a backdrop click through here, so ignoring them is what
      // makes the dialog must-dismiss (same shape as the AQU-1519 busy guard).
      onOpenChange={() => {}}
    >
      <DialogContent showCloseButton={false} data-testid="lane-archived-dialog">
        <DialogHeader>
          <DialogTitle>{t("editor.laneArchived.title", { lane: laneLabel })}</DialogTitle>
          <DialogDescription>
            {t("editor.laneArchived.body", { lane: laneLabel })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onAcknowledge} data-testid="lane-archived-acknowledge">
            {t("editor.laneArchived.acknowledge")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
