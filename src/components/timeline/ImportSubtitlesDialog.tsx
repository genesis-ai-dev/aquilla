// Extracting a clip's subtitles into the file the clip is attached to.
// (AQU-1139)
//
// Two steps, for the same reason `ImportAudioVttDialog` has two: the file is
// picked, parsed IN THE BROWSER, and its report shown before a single event is
// written. A video's sidecar files are easy to confuse — the subtitle track, a
// forced-narrative track, a different language — and the cue count and the span
// are the tells. Refusals are inline rather than a toast, because the dialog is
// where the mistake was made and where the next attempt happens.
//
// Deliberately NOT a copy of the audio-VTT dialog's reconcile half: this only
// ever runs on a file with no text of its own (the caller gates it), so there
// is nothing to reconcile against and no take to strand. Re-importing over
// existing cues is `import-file-target.ts`'s problem, not this one's.

import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { decodeImportText, MAX_UNKNOWN_TEXT_BYTES } from "@/lib/import/ai-recipe"
import {
  parseSubtitleSidecar,
  SUBTITLE_SIDECAR_ACCEPT,
  type ParsedSubtitleSidecar,
} from "@/lib/timeline/subtitle-source-import"
import {
  FramesAsHundredthsNotice,
  useFramesAsHundredths,
} from "@/components/import/FramesAsHundredthsNotice"
import { useT } from "@/lib/i18n/I18nProvider"
import { fmtClock } from "./format"

interface Props {
  open: boolean
  /** The time-ordered file the cues will land on — named so it is obvious
   *  which file is about to gain them. */
  textFileName: string
  /** The file's linked film, if any. AQU-2197: its frame rate is the one to
   *  read frame numbers written as hundredths at. */
  filmUrl?: string | null
  onConfirm(parsed: ParsedSubtitleSidecar): void
  onCancel(): void
}

/** The span the timed cues cover. Absent timings ⇒ nothing to state. */
function cueSpan(parsed: ParsedSubtitleSidecar): string | null {
  const { spanStartMs, spanEndMs } = parsed.report
  if (spanStartMs === undefined || spanEndMs === undefined) return null
  return `${fmtClock(spanStartMs / 1000)} – ${fmtClock(spanEndMs / 1000)}`
}

export function ImportSubtitlesDialog({ open, textFileName, filmUrl, onConfirm, onCancel }: Props) {
  const t = useT()
  const [picked, setPicked] = useState<{
    parsed: ParsedSubtitleSidecar
    fileName: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPicked(null)
      setError(null)
    }
  }, [open])

  const handleFile = async (file: File) => {
    setPicked(null)
    setError(null)
    if (file.size === 0) {
      setError(t("editor.timeline.importFileEmpty"))
      return
    }
    if (file.size > MAX_UNKNOWN_TEXT_BYTES) {
      setError(t("editor.timeline.importTooLargeText", { fileName: file.name }))
      return
    }
    try {
      // `parseSubtitleSidecar` throws a user-presentable message for both of
      // its refusals (wrong format, no cues), so there is no second copy of
      // either sentence here to drift from it.
      const parsed = parseSubtitleSidecar(
        file.name,
        decodeImportText(await file.arrayBuffer(), file.name),
      )
      setPicked({ parsed, fileName: file.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // AQU-2197: the same frames-as-hundredths check, notice and conversion as
  // every other VTT import; `fixed` is what the import writes.
  const frames = useFramesAsHundredths(picked?.parsed.cues, { filmUrl })
  const fixed = useMemo<ParsedSubtitleSidecar | null>(() => {
    if (!picked) return null
    if (frames.cues === picked.parsed.cues) return picked.parsed
    const starts = frames.cues.flatMap((c) => (typeof c.start === "number" ? [c.start] : []))
    const ends = frames.cues.flatMap((c) => (typeof c.end === "number" ? [c.end] : []))
    return {
      cues: [...frames.cues],
      report: {
        ...picked.parsed.report,
        ...(starts.length ? { spanStartMs: Math.round(Math.min(...starts) * 1000) } : {}),
        ...(ends.length ? { spanEndMs: Math.round(Math.max(...ends) * 1000) } : {}),
      },
    }
  }, [picked, frames.cues])

  const report = fixed?.report
  const span = fixed ? cueSpan(fixed) : null

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="import-subtitles-dialog">
        <DialogHeader>
          <DialogTitle>{t("editor.timeline.subtitleSourceTitle")}</DialogTitle>
          <DialogDescription>
            {t("editor.timeline.subtitleSourceDescription", { fileName: textFileName })}
          </DialogDescription>
        </DialogHeader>

        {picked && report ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">{picked.fileName}</p>
            <p className="text-muted-foreground" data-testid="import-subtitles-summary">
              {span
                ? t("editor.timeline.subtitleSourceCueSummary", {
                    count: report.totalCues,
                    span,
                  })
                : t("editor.timeline.subtitleSourceCueSummaryUntimed", {
                    count: report.totalCues,
                  })}
            </p>
            {report.repairedShortForm > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("editor.timeline.subtitleSourceRepairedShortForm", {
                  count: report.repairedShortForm,
                })}
              </p>
            )}
            {report.droppedCues > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="import-subtitles-dropped">
                {t("editor.timeline.subtitleSourceDroppedCues", { count: report.droppedCues })}
              </p>
            )}
            {report.untimedCues > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="import-subtitles-untimed">
                {t("editor.timeline.subtitleSourceUntimedCues", { count: report.untimedCues })}
              </p>
            )}
            {frames.state && (
              <div className="mt-2">
                <FramesAsHundredthsNotice
                  state={frames.state}
                  onChange={frames.setPick}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted p-6 text-center">
            <label>
              <span className="inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
                {t("editor.timeline.subtitleSourceChoose")}
              </span>
              <input
                type="file"
                accept={SUBTITLE_SIDECAR_ACCEPT}
                className="sr-only"
                data-testid="import-subtitles-input"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Clear the input so picking the SAME file again re-fires
                  // change — the usual second attempt after a refusal.
                  e.target.value = ""
                  if (file) void handleFile(file)
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {t("editor.timeline.subtitleSourcePickHint")}
            </p>
          </div>
        )}

        {error && (
          <p data-testid="import-subtitles-error" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" data-testid="import-subtitles-cancel" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="import-subtitles-confirm"
            disabled={!picked}
            onClick={() => {
              if (!fixed) return
              onConfirm(fixed)
            }}
          >
            {picked
              ? t("editor.timeline.subtitleSourceImportCues", { count: picked.parsed.cues.length })
              : t("editor.timeline.subtitleSourceImport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
