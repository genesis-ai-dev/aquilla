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

interface RestoreProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * AQU-2456: confirm before an archived project is restored. Same dialog as
 * other notices on this surface. The confirm button is the primary style —
 * restoring makes the project available again, so it is not destructive.
 */
export function RestoreProjectDialog({ open, onOpenChange, onConfirm }: RestoreProjectDialogProps) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("org.restoreProject.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("org.restoreProject.dialogBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="default"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {t("common.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
