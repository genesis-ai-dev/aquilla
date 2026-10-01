// How a take compares with the line's text, in a few words (Sam, 2026-09-29):
// the playing take's line and every row of the Recording tab's list say it the
// same way, from the same verdict the transcript card reads.

import { Check, Diff, FileClock } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { TranscriptVerdict } from "@/lib/audio/transcript-verdict"

export function TakeTextVerdict({
  verdict,
  onTranscribe,
  transcribeDisabled = false,
  testId,
}: {
  verdict: TranscriptVerdict
  /** Offered on "not transcribed" when the take can be transcribed from here. */
  onTranscribe?: () => void
  transcribeDisabled?: boolean
  testId?: string
}) {
  const t = useT()
  if (verdict.kind === "match") {
    return (
      <span data-testid={testId} data-verdict="match" className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
        <Check className="h-3 w-3" />
        {t("editor.recordingTab.matches")}
      </span>
    )
  }
  if (verdict.kind === "differs") {
    return (
      <span data-testid={testId} data-verdict="differs" className="flex shrink-0 items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
        <Diff className="h-3 w-3" />
        {t("editor.recordingTab.differs", { count: verdict.words })}
      </span>
    )
  }
  if (verdict.kind === "stale") {
    return (
      <span data-testid={testId} data-verdict="stale" className="flex shrink-0 items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
        <FileClock className="h-3 w-3" />
        {t("editor.recordingTab.stale")}
      </span>
    )
  }
  if (verdict.kind === "noText" || verdict.kind === "unchecked") {
    // Transcribed, with nothing to hold it against: no text on the line yet,
    // or a heard line saying one part of a split line (Sam, 2026-09-30).
    return (
      <span data-testid={testId} data-verdict={verdict.kind} className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        {t(verdict.kind === "noText" ? "editor.recordingTab.noTextToCompare" : "editor.recordingTab.transcribedOnly")}
      </span>
    )
  }
  return (
    <span data-testid={testId} data-verdict="none" className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      {t("editor.recordingTab.notTranscribed")}
      {onTranscribe && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={onTranscribe}
            disabled={transcribeDisabled}
            className="rounded text-foreground underline underline-offset-2 hover:text-primary disabled:opacity-50"
          >
            {t("editor.cell.transcribeShort")}
          </button>
        </>
      )}
    </span>
  )
}
