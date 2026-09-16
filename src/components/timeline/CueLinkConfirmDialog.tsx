// Asks before a pairing is made or broken. (AQU-646, Sam 2026-08-20)
//
// Linking mode is a click surface: one click picks a chip, the next click on
// the other row makes or breaks the pairing between them. That is exactly the
// speed it was built for, and exactly why a mis-click is dangerous — a pairing
// decides WHICH RECORDING BELONGS TO WHICH LINE, so getting one wrong
// misattributes a performance, and nothing on screen shouts about it
// afterwards.
//
// Sam asked for it on BOTH directions, knowing the cost: "I know that sounds
// super annoying, but for now better safe than sorry." It is affordable
// because the bulk pairing happens at import ("work out the subtitle
// pairings") — this mode is for correcting the tail, so the dialog is a
// handful of clicks in a session rather than one per cue.
//
// THE DIALOG NAMES BOTH SIDES rather than asking an abstract question. "Break
// this pairing?" on its own is unanswerable: the whole risk is that you
// clicked the wrong chip, and a confirmation that does not show you what you
// hit cannot catch that. Each side is its time and the opening of its text.

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
import { fmtClock } from "./format"

export interface CueLinkConfirmSide {
  startSec: number
  /** The line's words. Trimmed to a readable opening by this component. */
  text: string
}

interface Props {
  open: boolean
  /** True when the click would CREATE the pairing, false when it breaks one. */
  linking: boolean
  subtitle: CueLinkConfirmSide | null
  cue: CueLinkConfirmSide | null
  onConfirm(): void
  onCancel(): void
}

/** Enough to recognise the line, short enough to sit on one row. */
const SNIPPET_MAX = 64

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat
}

function Side({ label, side }: { label: string; side: CueLinkConfirmSide | null }) {
  if (!side) return null
  return (
    <div className="flex gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs">
      <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
      <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
        {fmtClock(side.startSec)}
      </span>
      <span className="min-w-0 truncate text-foreground">{snippet(side.text)}</span>
    </div>
  )
}

export function CueLinkConfirmDialog({
  open,
  linking,
  subtitle,
  cue,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="cue-link-confirm">
        <DialogHeader>
          <DialogTitle>
            {linking ? t("editor.timeline.linkConfirmTitle") : t("editor.timeline.unlinkConfirmTitle")}
          </DialogTitle>
          <DialogDescription>
            {linking
              ? t("editor.timeline.linkConfirmDescription")
              : t("editor.timeline.unlinkConfirmDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Side label={t("editor.timeline.chipHeadingSubtitle")} side={subtitle} />
          <Side label={t("editor.timeline.linkConfirmHeardSide")} side={cue} />
        </div>
        <DialogFooter>
          <Button variant="outline" data-testid="cue-link-confirm-cancel" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="cue-link-confirm-go"
            variant={linking ? "default" : "destructive"}
            onClick={onConfirm}
          >
            {linking ? t("editor.timeline.linkConfirmGo") : t("editor.timeline.unlinkConfirmGo")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
