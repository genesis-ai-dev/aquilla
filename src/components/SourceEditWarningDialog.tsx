// A source edit rewrites the text every target language shares. On a project
// with two or more target lanes, confirm before the editor opens.

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

export function SourceEditWarningDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent data-testid="source-edit-lane-warning">
        <DialogHeader>
          <DialogTitle>{t("editor.source.multiLaneTitle")}</DialogTitle>
          <DialogDescription>
            {t("editor.source.multiLaneBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button data-testid="source-edit-lane-warning-confirm" onClick={onConfirm}>
            {t("editor.source.multiLaneConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
