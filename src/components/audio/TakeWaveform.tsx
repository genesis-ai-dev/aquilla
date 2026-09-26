// A saved take, playing, drawn as the timeline chip. (AQU-1210 / AQU-1217, 2026-09-25)
//
// WaveformRect is the picture; this is the take behind it. It binds one
// `useCellAudio` controller to the rectangle — peaks, position, play/pause,
// seek — and owns the one thing every surface that shows a saved take now
// shares: its trim.
//
//   - The KEPT part is what plays. Trimmed-off audio is still drawn, faded.
//   - Where trimming is allowed (the Recording tab, the Audio view card — Sam:
//     "trim right where you see it", which is why the Crop popover is retired)
//     the kept part's two edges are plain lines you drag, or click and nudge
//     with the arrow keys. The drag's value leads while you hold it; on release
//     the caller persists it and the stored trim catches up.
//   - Where it is only shown (the recorder's ready screen) the edges are grey
//     and inert.
//   - An imported SOURCE-AUDIO section is not a take: its window is the
//     section's own timing. It is drawn as that section alone and never
//     offers edges — retime the section on the timeline instead.
//
// Loading, needs-a-click, missing and failed are CellWaveform's states,
// carried over unchanged (the design pass parked restyling them).

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, CloudDownload, Download, RotateCw } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import { WAVEFORM_BINS } from "@/lib/audio/peaks-loader"
import {
  moveTrimEnd,
  moveTrimStart,
  sameTrim,
  TRIM_NUDGE_COARSE_SEC,
  TRIM_NUDGE_SEC,
  type TrimValue,
} from "@/lib/audio/trim-edit"
import type { KeptWindow } from "@/lib/audio/kept-window"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"
import type { AudioMediaStrategy } from "@/lib/parsers/types"
import { WaveformRect, type WaveformEdge } from "./WaveformRect"

const AUTO_LOAD: ReadonlySet<AudioMediaStrategy> = new Set(["lazy", "eager"])

export interface TakeWaveformProps {
  controller: UseCellAudioResult
  /** Identifies the take, so a drag in progress never leaks onto the next one. */
  audioId: string | null | undefined
  kept: KeptWindow
  height: number
  kind?: "take" | "generated"
  /** The project's media strategy: "stream"/"manual" wait for a click. */
  strategy?: AudioMediaStrategy
  /** Offer draggable trim edges. Ignored for a source-audio section. */
  trimEditable?: boolean
  /** Persist a finished drag or nudge. Null = back to the clip's edge. */
  onCommitTrim?: (start: number | null, end: number | null) => void
  onRecord?: () => void
  recordLabel?: string
  recordGlyph?: React.ReactNode
  validation?: "self" | "full" | null
  className?: string
  testId?: string
  children?: React.ReactNode
}

export function TakeWaveform({
  controller,
  audioId,
  kept,
  height,
  kind = "take",
  strategy = "lazy",
  trimEditable = false,
  onCommitTrim,
  onRecord,
  recordLabel,
  recordGlyph,
  validation = null,
  className,
  testId,
  children,
}: TakeWaveformProps) {
  const t = useT()
  const { peaks, peaksState, currentTime, duration, isPlaying, state, error, play, pause, seek, setTrim, requestPeaks } = controller

  // ── Peaks, on the project's terms ────────────────────────────────────
  const [userTriggered, setUserTriggered] = useState(false)
  const shouldLoad = AUTO_LOAD.has(strategy) || userTriggered
  useEffect(() => {
    if (shouldLoad) void requestPeaks(WAVEFORM_BINS)
  }, [shouldLoad, requestPeaks, audioId])

  // ── The trim: stored, with a drag leading it ──────────────────────────
  const isSection = kept.kind === "section"
  const stored: TrimValue = { start: kept.start, end: kept.end }
  const [draft, setDraftState] = useState<(TrimValue & { audioId: string | null | undefined }) | null>(null)
  // The commit fires in the same event as the last nudge, before React has
  // re-rendered — so it reads the draft from here, never from a stale closure.
  const draftRef = useRef<TrimValue | null>(null)
  const setDraft = (v: (TrimValue & { audioId: string | null | undefined }) | null) => {
    draftRef.current = v
    setDraftState(v)
  }
  const live = draft && draft.audioId === audioId && !sameTrim(draft, stored) ? draft : null
  const trim: TrimValue = live ?? stored
  useEffect(() => {
    setTrim(trim.start, trim.end)
    // audioId: the controller drops its window when the take changes, so an
    // identical window on the new take must re-apply.
  }, [setTrim, trim.start, trim.end, audioId])

  // ── What is drawn: the whole clip, or a source section's slice of it ──
  const dur = duration > 0 ? duration : 0
  const viewStart = isSection ? (kept.start ?? 0) : 0
  const viewEnd = isSection ? (kept.end ?? dur) : dur
  const viewLen = Math.max(0, viewEnd - viewStart)
  const drawnPeaks = useMemo(() => {
    if (!peaks || peaks.length === 0) return peaks
    if (!isSection || !(dur > 0)) return peaks
    const n = peaks.length
    const a = Math.max(0, Math.floor((viewStart / dur) * n))
    const b = Math.min(n, Math.max(a + 1, Math.ceil((viewEnd / dur) * n)))
    return peaks.slice(a, b)
  }, [peaks, isSection, dur, viewStart, viewEnd])
  const toFrac = (sec: number) => (viewLen > 0 ? (sec - viewStart) / viewLen : 0)

  const keep = !isSection && dur > 0 && (trim.start != null || trim.end != null)
    ? { start: toFrac(trim.start ?? 0), end: toFrac(trim.end ?? dur) }
    : null

  // ── Edges ─────────────────────────────────────────────────────────────
  const canEdit = trimEditable && !isSection && dur > 0 && Boolean(onCommitTrim)
  const showReadOnly = !canEdit && !isSection && dur > 0 && kept.kind === "trim"
  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`
  // The save paints the new window at once (an optimistic overlay, in the same
  // event), so the drag's own value can retire as it is handed over.
  const commit = (v: TrimValue) => {
    onCommitTrim?.(v.start, v.end)
    setDraft(null)
  }
  const edges: WaveformEdge[] = canEdit || showReadOnly
    ? [
        {
          key: "start",
          at: toFrac(trim.start ?? 0),
          label: t("editor.waveform.trimStart"),
          valueText: fmt(trim.start ?? 0),
          editable: canEdit,
          onDrag: (f) => setDraft({ audioId, ...moveTrimStart(trim, f * dur, dur) }),
          onNudge: (dir, coarse) => {
            const next = moveTrimStart(trim, (trim.start ?? 0) + dir * (coarse ? TRIM_NUDGE_COARSE_SEC : TRIM_NUDGE_SEC), dur, { snap: false })
            setDraft({ audioId, ...next })
          },
          onCommit: () => { if (draftRef.current) commit(draftRef.current) },
        },
        {
          key: "end",
          at: toFrac(trim.end ?? dur),
          label: t("editor.waveform.trimEnd"),
          valueText: fmt(trim.end ?? dur),
          editable: canEdit,
          onDrag: (f) => setDraft({ audioId, ...moveTrimEnd(trim, f * dur, dur) }),
          onNudge: (dir, coarse) => {
            const next = moveTrimEnd(trim, (trim.end ?? dur) + dir * (coarse ? TRIM_NUDGE_COARSE_SEC : TRIM_NUDGE_SEC), dur, { snap: false })
            setDraft({ audioId, ...next })
          },
          onCommit: () => { if (draftRef.current) commit(draftRef.current) },
        },
      ]
    : []

  // ── Status overlays (CellWaveform's, unchanged) ───────────────────────
  const needsClick = !shouldLoad && peaksState === "idle"
  const status = needsClick ? (
    <button
      type="button"
      onClick={() => setUserTriggered(true)}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
    >
      <Download className="h-3 w-3" />
      <span>{t("editor.waveform.load")}</span>
    </button>
  ) : peaksState === "missing" ? (
    <span role="status" className="text-[10px] font-medium text-muted-foreground">{MISSING_AUDIO_MESSAGE}</span>
  ) : peaksState === "error" ? (
    <button
      type="button"
      onClick={() => { setUserTriggered(true); void requestPeaks(WAVEFORM_BINS, { force: true }) }}
      aria-label={t("editor.waveform.retry")}
      title={t("editor.waveform.retryTooltip")}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-300"
    >
      <RotateCw className="h-3 w-3" />
      <span>{t("editor.waveform.retry")}</span>
    </button>
  ) : null

  const playGlyph = state === "loading"
    ? <Spinner className="size-2.5" />
    : state === "error"
      ? <AlertCircle className="h-2.5 w-2.5 text-destructive" />
      : state === "cloud" && !isPlaying
        ? <CloudDownload className="h-2.5 w-2.5" />
        : undefined

  return (
    <WaveformRect
      peaks={drawnPeaks}
      height={height}
      kind={kind}
      keep={keep}
      playing={isPlaying}
      progress={viewLen > 0 ? toFrac(currentTime) : null}
      onTogglePlay={() => { if (isPlaying) pause(); else void play() }}
      playLabel={t("editor.audio.play")}
      stopLabel={t("common.pause")}
      playGlyph={playGlyph}
      playDisabled={state === "loading"}
      onRecord={onRecord}
      recordLabel={recordLabel}
      recordGlyph={recordGlyph}
      validation={validation}
      validationLabel={validation === "full"
        ? t("workspace.targetAudioLane.takeValidated")
        : t("workspace.targetAudioLane.takeValidatedByYou")}
      onSeek={viewLen > 0 ? (f) => seek(viewStart + f * viewLen) : undefined}
      seekLabel={t("common.seek")}
      edges={edges}
      status={status}
      className={className}
      testId={testId}
    >
      {peaksState === "loading" && (
        <div aria-hidden className="pointer-events-none absolute inset-x-2 top-1/2 h-px animate-pulse bg-foreground/30" />
      )}
      {state === "error" && error && (
        <span className="sr-only" role="status">{error.message}</span>
      )}
      {children}
    </WaveformRect>
  )
}
