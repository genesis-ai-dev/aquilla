import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { HealthRing } from "./HealthRing"
import { DecayBreakdown } from "./DecayBreakdown"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { bidiIsolate, formatNumber, formatPercent } from "@/lib/i18n/format"
import { progressPercent } from "@/lib/progress/progress-percent"
import { PROGRESS_BG } from "@/lib/progress/progress-palette"
import { fileProgressView, type FileStats } from "@/lib/progress/file-summary-progress"

interface StatusBarProps {
  /**
   * AQU-2111: `recorded` / `audioValidated` are OPTIONAL and undefined means
   * "this file has no audio figures here" — an older sync-worker, or the live
   * count before the attachment map lands. The footer draws the audio half
   * only when it has one, because a fabricated 0 would read as "nothing
   * recorded" over a file where every line has a take.
   *
   * Media redesign: `delivers`, when someone has chosen, decides which of the
   * figures the footer reports (`fileProgressView`). Text and audio reads the
   * lines DONE on both halves — `validated` — and what is left of each.
   */
  progress: FileStats
  getHealthByCell: () => Array<{ cellId: string; label: string; health: number }>
  projectHealth: number
  staleSourceCount?: number
  onJumpToCell?: (cellId: string) => void
  /**
   * AQU-1083: `progress` must already reflect the project's structural-cell
   * policy — this footer no longer sees cells, so it cannot apply it itself.
   * ProjectWorkspace resolves it with `applyStructuralPolicy` before passing
   * the numbers down; see `@/lib/cells/structural`.
   */
  className?: string
}

/**
 * The one figure the footer leads with, as a fraction, and whether it counts
 * recordings rather than text. The media view's status ring draws the same
 * number, so the ring and the counts it opens onto can never disagree.
 */
export function statusBarFigure(progress: FileStats): { fraction: number; audio: boolean } {
  const view = fileProgressView(progress)
  const bothDone = view === "both" && progress.delivers === "text_and_audio"
  const audioOnly = view === "audio"
  const recorded = progress.recorded ?? (progress.delivers === "audio" ? progress.translated : 0)
  const done = bothDone ? progress.validated : audioOnly ? recorded : progress.translated
  return { fraction: progressPercent(done, progress.total) / 100, audio: audioOnly }
}

export function StatusBar({
  progress, getHealthByCell, projectHealth, staleSourceCount, onJumpToCell, className,
}: StatusBarProps) {
  const { locale, t } = useI18n()
  const { total, translated, validated } = progress
  // An Audio language's started / done lines ARE its recorded / approved ones.
  const recorded = progress.recorded ?? (progress.delivers === "audio" ? translated : 0)
  const audioValidated = progress.audioValidated ?? (progress.delivers === "audio" ? validated : 0)
  const unvalidated = translated - validated
  const unvalidatedAudio = recorded - audioValidated
  // AQU-2111: the display rule AQU-2110 settled, in the footer. A file with
  // recordings and no target text reports its audio instead of "0 translated
  // (0%)"; a file with both reports text as before and gains the audio
  // badges; a text-only file is untouched. What the language delivers wins
  // where someone has chosen (media redesign): Text never draws audio, Audio
  // reports its recordings, and Text and audio its lines done on both halves.
  const view = fileProgressView(progress)
  const bothDone = view === "both" && progress.delivers === "text_and_audio"
  const audioOnly = view === "audio"
  const showText = !audioOnly && !bothDone
  const showAudio = !bothDone && view !== "text" && recorded > 0
  // AQU-1493: never "100%" while a cell is still blank — 251 of 252 is 99%.
  const { fraction } = statusBarFigure(progress)
  // The ratio/percent run reorders under Arabic's bidi algorithm when this
  // footer sits inside an <html dir="rtl"> page (a user photographed exactly
  // this) even though the surrounding words stay English — isolate each
  // formatted numeric token so its digits/punctuation can't be reordered.
  const totalDisplay = bidiIsolate(formatNumber(total, locale))
  const translatedDisplay = bidiIsolate(formatNumber(audioOnly ? recorded : translated, locale))
  const pctDisplay = bidiIsolate(`(${formatPercent(fraction, locale)})`)
  // AQU-2337: the legend badges get their own wrapping row so the summary
  // keeps its line. The badges are `shrink-0 whitespace-nowrap`, so when they
  // shared a non-wrapping group with the summary the summary was the only
  // element that could give way, and inside the media view's 320 px status
  // popover (where the footer itself wraps) it collapsed to one word per line
  // while the health ring was pushed onto a line of its own. A flex line
  // breaks on a group's whole content, so the ring and the summary now travel
  // together in one group and the badges drop below them. An empty group
  // would still eat a gap, so the legend row is drawn only when it has a
  // badge in it.
  const needsText = bothDone ? (progress.needsText ?? 0) : 0
  const needsAudio = bothDone ? (progress.needsAudio ?? 0) : 0
  const hasLegend =
    needsText > 0 || needsAudio > 0 ||
    (showText && (unvalidated > 0 || validated > 0)) ||
    (showAudio && (unvalidatedAudio > 0 || audioValidated > 0))

  return (
    <footer className={cn(
      "relative z-10 flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground",
      className,
    )}>
      <span className="flex items-center gap-2.5" data-testid="status-bar-counts">
        <DecayBreakdown
          health={projectHealth}
          scopeLabel={t("workspace.statusBar.healthTitle")}
          label={t("workspace.statusBar.healthAria", { percent: projectHealth })}
          getHealthByCell={getHealthByCell}
          staleSourceCount={staleSourceCount}
          onJumpToCell={onJumpToCell}
        >
          <HealthRing health={projectHealth} size={18} strokeWidth={2}>
            <span className="text-[7px] font-bold">{projectHealth}</span>
          </HealthRing>
        </DecayBreakdown>
        <span className="whitespace-nowrap" data-testid="status-bar-summary">
          {bothDone
            ? t("workspace.statusBar.bothSummary", {
                total: totalDisplay,
                done: bidiIsolate(formatNumber(validated, locale)),
                pct: pctDisplay,
              })
            : t(audioOnly ? "workspace.statusBar.audioSummary" : "workspace.statusBar.summary", {
                total: totalDisplay,
                translated: translatedDisplay,
                pct: pctDisplay,
              })}
        </span>
      </span>
      {hasLegend && (
        <span className="flex flex-wrap items-center gap-2" data-testid="status-bar-legend">
          {/* Media redesign: Text and audio says how much of each half is left. */}
          {needsText > 0 && (
            <Badge variant="secondary" className="text-foreground" data-testid="status-bar-text-left">
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${PROGRESS_BG.textTranslated}`} />
              {t("workspace.statusBar.textLeftBadge", { count: bidiIsolate(formatNumber(needsText, locale)) })}
            </Badge>
          )}
          {needsAudio > 0 && (
            <Badge variant="secondary" className="text-foreground" data-testid="status-bar-audio-left">
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${PROGRESS_BG.audioRecorded}`} />
              {t("workspace.statusBar.audioLeftBadge", { count: bidiIsolate(formatNumber(needsAudio, locale)) })}
            </Badge>
          )}
          {/* Grouped like the counts beside them ("1,207 validated", not
              "1207"); the plural form still reads the digits.
              AQU-1764: the words are in the text colour and the colour sits in
              a swatch before them, the same light and dark blue the file's bar
              in the sidebar is drawn in. They were amber and green. */}
          {showText && unvalidated > 0 && (
            <Badge variant="secondary" className="text-foreground" data-testid="status-bar-unvalidated">
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${PROGRESS_BG.textTranslated}`} />
              {t("workspace.statusBar.unvalidatedBadge", {
                count: bidiIsolate(formatNumber(unvalidated, locale)),
              })}
            </Badge>
          )}
          {showText && validated > 0 && (
            <Badge variant="secondary" className="text-foreground" data-testid="status-bar-validated">
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${PROGRESS_BG.textValidated}`} />
              {t("terminology.livingMemory.validatedCount", {
                count: bidiIsolate(formatNumber(validated, locale)),
              })}
            </Badge>
          )}
          {/* AQU-2111: the audio twins, in the palette's magenta tones — light
              for recorded but not validated, dark for audio validated. */}
          {showAudio && unvalidatedAudio > 0 && (
            <Badge variant="secondary" className="text-foreground" data-testid="status-bar-unvalidated-audio">
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${PROGRESS_BG.audioRecorded}`} />
              {t("workspace.statusBar.unvalidatedAudioBadge", {
                count: bidiIsolate(formatNumber(unvalidatedAudio, locale)),
              })}
            </Badge>
          )}
          {showAudio && audioValidated > 0 && (
            <Badge variant="secondary" className="text-foreground" data-testid="status-bar-validated-audio">
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${PROGRESS_BG.audioValidated}`} />
              {t("workspace.statusBar.audioValidatedBadge", {
                count: bidiIsolate(formatNumber(audioValidated, locale)),
              })}
            </Badge>
          )}
        </span>
      )}
    </footer>
  )
}
