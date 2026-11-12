// AQU-1759 — SplitAtQuotesDialog
// ---------------------------------------------------------------------------
// The preview a split gets before it happens. A split rewrites the client's
// source text and adds lines to every language at once, and the scanner
// deciding where the seams fall is a heuristic over many quoting conventions —
// so the person sees exactly the lines it will make, each tagged narration or
// quotation, and confirms. Nothing is sent until they do.
//
// AQU-2089: a piece's `text` keeps its USFM markup, because the split writes
// that text back as the new lines' source. The preview is a reading surface,
// so it shows the same marker-free text the editor shows — display only; the
// pieces handed to the split are untouched.

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { QuoteSplitPiece } from "@/lib/cells/quote-split"
import { usfmDisplayText } from "@/lib/parsers/usfm-display"
import { useT } from "@/lib/i18n/I18nProvider"

interface SplitAtQuotesDialogProps {
  /** The lines the split will make, in order. Null closes the dialog. */
  pieces: readonly QuoteSplitPiece[] | null
  /** The line has recordings of its own — say they stay where they are. */
  hasRecordings: boolean
  /** Live target languages. Two or more gets the shared-source warning. */
  targetLaneCount?: number
  onConfirm: () => void
  onCancel: () => void
}

export function SplitAtQuotesDialog({ pieces, hasRecordings, targetLaneCount = 1, onConfirm, onCancel }: SplitAtQuotesDialogProps) {
  const t = useT()
  const count = pieces?.length ?? 0
  return (
    <Dialog open={pieces !== null} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent data-testid="split-quotes-dialog">
        <DialogHeader>
          <DialogTitle>{t("editor.splitQuotes.title")}</DialogTitle>
          <DialogDescription>{t("editor.splitQuotes.description", { count })}</DialogDescription>
        </DialogHeader>
        <ol className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm">
          {(pieces ?? []).map((piece, i) => (
            <li
              key={i}
              data-testid="split-quotes-piece"
              data-kind={piece.kind}
              className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2"
            >
              <Badge variant={piece.kind === "quote" ? "default" : "soft"} className="mt-0.5 shrink-0">
                {piece.kind === "quote" ? t("editor.splitQuotes.quotation") : t("editor.splitQuotes.narration")}
              </Badge>
              <span dir="auto" className="min-w-0 break-words whitespace-pre-line">
                {usfmDisplayText(piece.text)}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          {t("editor.splitQuotes.translationsNote")}
          {hasRecordings ? ` ${t("editor.splitQuotes.recordingsNote")}` : ""}
        </p>
        {targetLaneCount >= 2 && (
          <p data-testid="split-quotes-lane-warning" className="text-sm text-amber-800 dark:text-amber-200">
            {t("editor.splitQuotes.multiLaneWarning")}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button data-testid="split-quotes-confirm" onClick={onConfirm}>
            {t("editor.splitQuotes.confirm", { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
