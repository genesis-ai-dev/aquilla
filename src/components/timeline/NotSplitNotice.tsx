// AQU-2426: "Not split into lines yet" (board 58, part 2) — on a whole recording
// over about a minute that is still one line, in the Text view under its
// timing and on the timeline inside its clip, with Transcribe… and Split at
// pauses beside it.
//
// Everyone sees the words; the buttons show only to people who can split
// lines, with Transcribe… greyed and its (i) for those who may not transcribe
// (a Reviewer still learns why the file is one long line). In the Text view
// the (i) opens its reason in place; inside a clip there's no room, so it opens
// a small note on a click.

import { useId } from "react"
import { Info, Scissors, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { transcribeBlockReason } from "@/components/import/RecordingImportChoiceDialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { TranscribeBlock } from "@/lib/audio/transcribe-access"

export interface NotSplitNoticeProps {
  /** May this person split lines here (the buttons show only then). */
  canSplit: boolean
  /** Why this person may not transcribe, or null. */
  block: TranscribeBlock | null
  onTranscribe(): void
  onSplitAtPauses(): void
  busy?: boolean
}

/** The Text view's notice, under a whole line's timing. */
export function NotSplitNoticeText({ canSplit, block, onTranscribe, onSplitAtPauses, busy }: NotSplitNoticeProps) {
  const t = useT()
  const [open, toggle] = useInfoOpen()
  const id = useId()
  return (
    <div className="mt-2 flex flex-col" data-testid="not-split-notice">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t("editor.splitLines.notSplitYet")}</span>
        {canSplit && (
          <>
            <span className="inline-flex items-center gap-0.5">
              <Button variant="outline" size="xs" disabled={busy || block !== null} onClick={onTranscribe}
                data-testid="not-split-transcribe">
                <Sparkles data-icon="inline-start" />
                {t("editor.splitLines.transcribe")}
              </Button>
              {block && <InfoToggle open={open} onToggle={toggle} controls={id} label={t("editor.splitLines.whyNot")} />}
            </span>
            <Button variant="outline" size="xs" disabled={busy} onClick={onSplitAtPauses} data-testid="not-split-pauses">
              <Scissors data-icon="inline-start" />
              {t("editor.splitLines.splitAtPauses")}
            </Button>
          </>
        )}
      </div>
      {canSplit && block && (
        <InfoReveal open={open} id={id} className="max-w-[460px] text-xs text-muted-foreground">
          {transcribeBlockReason(t, block, t("audio.transcribeBlock.splitFree"))}
        </InfoReveal>
      )}
    </div>
  )
}

/** The timeline's own small notice buttons (the ones "Measure now" uses). */
function NoteButton({ children, disabled, onClick, testId }: {
  children: React.ReactNode
  disabled?: boolean
  onClick(): void
  testId?: string
}) {
  return (
    <button type="button" disabled={disabled} data-testid={testId}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium leading-[15px] text-foreground/80",
        "hover:bg-accent disabled:opacity-50 [&_svg]:size-3",
      )}>
      {children}
    </button>
  )
}

/** Inside the Source audio clip on the timeline, after its name and times. */
export function NotSplitNoticeClip({ canSplit, block, onTranscribe, onSplitAtPauses, busy }: NotSplitNoticeProps) {
  const t = useT()
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-[11px] text-foreground" data-testid="not-split-notice-clip">
      <span className="text-foreground/75">{t("editor.splitLines.notSplitYet")}</span>
      {canSplit && (
        <>
          <span className="inline-flex items-center gap-0.5">
            <NoteButton disabled={busy || block !== null} onClick={onTranscribe} testId="not-split-clip-transcribe">
              <Sparkles aria-hidden="true" />
              {t("editor.splitLines.transcribe")}
            </NoteButton>
            {block && (
              <Popover>
                <PopoverTrigger render={<button type="button" aria-label={t("editor.splitLines.whyNot")}
                  onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
                  className="inline-flex rounded-sm p-0.5 text-muted-foreground hover:text-foreground" />}>
                  <Info className="h-3.5 w-3.5" aria-hidden="true" />
                </PopoverTrigger>
                <PopoverContent className="w-72 p-3 text-xs leading-relaxed">
                  {transcribeBlockReason(t, block, t("audio.transcribeBlock.splitFree"))}
                </PopoverContent>
              </Popover>
            )}
          </span>
          <NoteButton disabled={busy} onClick={onSplitAtPauses} testId="not-split-clip-pauses">
            <Scissors aria-hidden="true" />
            {t("editor.splitLines.splitAtPauses")}
          </NoteButton>
        </>
      )}
    </span>
  )
}
