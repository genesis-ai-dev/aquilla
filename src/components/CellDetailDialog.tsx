// AQU-2021 — the cell's detail view, as a pop-up modal.
//
// Joel could not find a cell's detailed view (audio, takes, back-translation):
// the only way in was the small chevron on the hover rail. Double-clicking the
// row now opens the SAME tab shell (`CellExpansion`) centred over the table,
// where one cell has the screen to itself.
//
// This component is only the frame: the dialog surface, the line's name, and
// previous/next so a reviewer can walk the file without closing the modal and
// hunting for the next row. The tabs and their content stay where they are
// wired, in the row.
//
// Which cell is open lives at the TABLE level, not here — the list is
// virtualized, so stepping to the next cell has to scroll that row into the
// window as well as change the id, or the row rendering this dialog unmounts
// under it.

import { ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  open: boolean
  /** The line's name, as the row's own aria-label uses it (e.g. "GEN 1:1"). */
  cellRef: string
  onClose: () => void
  /** Step to the previous / next cell in the list the table is displaying.
   *  Absent (or false `has*`) at the ends of the file. */
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
  children: React.ReactNode
}

export function CellDetailDialog({
  open, cellRef, onClose, onPrev, onNext, hasPrev, hasNext, children,
}: Props) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        className="sm:max-w-3xl"
        data-cell-detail-dialog
        // The row underneath keeps its own click handlers; a click inside the
        // dialog is about this cell's details, never the row's selection.
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          {/* pe-14 keeps the title clear of the dialog's own close button. */}
          <div className="flex items-center gap-2 pe-14">
            <DialogTitle className="min-w-0 flex-1 truncate">
              {t("editor.cellDetail.title", { ref: cellRef })}
            </DialogTitle>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onPrev}
                disabled={!hasPrev}
                aria-label={t("editor.cellDetail.previous")}
                data-cell-detail-prev
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onNext}
                disabled={!hasNext}
                aria-label={t("editor.cellDetail.next")}
                data-cell-detail-next
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <DialogDescription>{t("editor.cellDetail.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}
