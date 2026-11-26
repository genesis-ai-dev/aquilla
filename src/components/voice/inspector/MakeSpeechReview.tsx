// Make speech: the check between translating and speaking. Speech costs more
// than a draft, so a person reads the drafted lines, fixes what is wrong, and
// only then is any speech made.
import { useState } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface MakeSpeechReviewLine {
  cellId: string
  /** The source text the draft was made from. */
  source: string
  /** The drafted translation, as it is now. */
  text: string
}

export function MakeSpeechReview({ lines, onConfirm, onCancel }: {
  lines: MakeSpeechReviewLine[]
  /** The text of every line, edited or not. */
  onConfirm: (texts: Map<string, string>) => void
  onCancel: () => void
}) {
  const t = useT()
  const [texts, setTexts] = useState(() => new Map(lines.map((l) => [l.cellId, l.text])))
  const empty = [...texts.values()].some((text) => !text.trim())
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-lg" data-testid="make-speech-review">
        <DialogHeader>
          <DialogTitle>{t("audio.makeSpeech.reviewTitle", { count: lines.length })}</DialogTitle>
          <DialogDescription>{t("audio.makeSpeech.reviewBody")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[60vh] space-y-3 overflow-y-auto">
          {lines.map((line) => (
            <div key={line.cellId} className="space-y-1">
              <p dir="auto" className="text-xs text-muted-foreground">{line.source}</p>
              <Textarea
                dir="auto"
                rows={2}
                aria-label={line.source}
                value={texts.get(line.cellId) ?? ""}
                onChange={(e) => {
                  const value = e.target.value
                  setTexts((cur) => new Map(cur).set(line.cellId, value))
                }}
                className="text-sm"
              />
            </div>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>{t("audio.makeSpeech.reviewCancel")}</Button>
          <Button type="button" disabled={empty} onClick={() => onConfirm(texts)} data-testid="make-speech-review-confirm">
            {t("audio.makeSpeech.reviewConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
