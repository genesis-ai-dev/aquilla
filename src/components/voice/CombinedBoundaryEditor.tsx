// Manual boundary editor for a "Voice together" combined clip.
//
// After several lines are synthesized into ONE clip (combined-voice.ts), this
// modal shows that clip's waveform once with a draggable divider between each
// consecutive line. The user drags the dividers to mark where each line falls;
// clicking a segment previews just that line. Save writes each cell's
// [start,end] slice as its trim — localStorage (the live cache the player
// reads) plus a server re-attach (cell.audio.attach with trimStartMs/EndMs),
// the same persistence path the per-cell crop uses.
//
// No silence/ASR auto-detection: the dividers ARE the boundaries. They default
// to a proportional-by-text-length split as a starting guess.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Pause, Play, X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { WaveformRect, type WaveformEdge } from "@/components/audio/WaveformRect"
import { WAVEFORM_BINS } from "@/lib/audio/peaks-loader"
import { TRIM_NUDGE_COARSE_SEC, TRIM_NUDGE_SEC } from "@/lib/audio/trim-edit"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useCellAudio } from "@/hooks/useCellAudio"
import { persistTakeTrim } from "@/lib/audio/persist-trim"
import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { takeTrackVars } from "@/lib/timeline/take-colors"

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function fmt(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

/** A short label for a cell segment: line number + a snippet of its text. */
function snippet(cell: CellData, i: number): string {
  const t = (cell.translated ?? "").trim().replace(/\s+/g, " ")
  return `${i + 1}. ${t.length > 28 ? t.slice(0, 27) + "…" : t || "(line)"}`
}

export interface CombinedBoundaryEditorProps {
  project: ProjectRecord
  fileId: string
  /** Shared clip object name (audioId.ext) + url, attached to every cell. */
  audioId: string
  url: string
  voiceId: string
  referenceAudioId?: string
  /** The voiced cells, in document order (matches the clip's line order). */
  cells: CellData[]
  session: FrontierSession | null
  username: string
  onClose: () => void
  /** Called after slices are saved so the host can revalidate. */
  onSaved?: () => void
}

export function CombinedBoundaryEditor(props: CombinedBoundaryEditorProps) {
  const { project, fileId, audioId, url, voiceId, referenceAudioId, cells, username, onClose, onSaved } = props
  const t = useT()
  const n = cells.length

  // One controller for the shared clip — a synthetic cell pointing at it.
  const cellForAudio = useMemo(() => ({
    kind: 2 as const,
    languageId: "html",
    value: "",
    metadata: {
      id: cells[0].id,
      type: "text" as const,
      attachments: { [audioId]: { url, type: "audio" } },
      selectedAudioId: audioId,
    },
  } as unknown as CodexCell), [cells, audioId, url])

  const audio = useCellAudio(project, cellForAudio, fileId)
  const { duration, isPlaying, currentTime, seek, play, pause, setTrim, peaks, requestPeaks } = audio

  // Decode the clip's peaks on open (it also yields `duration`, which places
  // the cuts). ONE request at the shared bin count — two differently-binned
  // decodes once raced and surfaced a spurious "Retry waveform".
  useEffect(() => { void requestPeaks(WAVEFORM_BINS) }, [requestPeaks])

  // N-1 internal cut times (seconds). Initialized proportional to text length
  // once the clip duration is known; the user drags from there.
  const [cuts, setCuts] = useState<number[] | null>(null)
  useEffect(() => {
    if (cuts || duration <= 0 || n < 2) return
    const lens = cells.map((c) => Math.max(1, (c.translated ?? "").trim().length))
    const total = lens.reduce((a, b) => a + b, 0)
    const out: number[] = []
    let cum = 0
    for (let i = 0; i < n - 1; i++) {
      cum += lens[i]
      out.push((cum / total) * duration)
    }
    setCuts(out)
  }, [cuts, duration, n, cells])

  // Which segment is currently being previewed (for highlight).
  const [activeSeg, setActiveSeg] = useState<number | null>(null)


  const segBounds = useCallback((i: number): { start: number; end: number } => {
    const c = cuts ?? []
    const start = i === 0 ? 0 : c[i - 1] ?? 0
    const end = i === n - 1 ? duration : c[i] ?? duration
    return { start, end }
  }, [cuts, n, duration])

  const moveCutTo = (idx: number, t: number) => {
    if (!cuts || duration <= 0) return
    const lo = (idx === 0 ? 0 : cuts[idx - 1]) + 0.05
    const hi = (idx === n - 2 ? duration : cuts[idx + 1]) - 0.05
    const next = cuts.slice()
    next[idx] = clamp(t, lo, hi)
    setCuts(next)
  }

  // Each divider is a split point: the same plain, opaque line every trim edge
  // is (Sam, 2026-09-25) — the resize cursor is its only decoration.
  const edges: WaveformEdge[] = cuts && duration > 0
    ? cuts.map((cut, idx) => ({
        key: `cut-${idx}`,
        at: cut / duration,
        label: t("audio.boundaryEditor.dividerLabel", { index: idx + 1 }),
        valueText: fmt(cut),
        editable: true,
        onDrag: (f: number) => moveCutTo(idx, f * duration),
        onNudge: (dir: -1 | 1, coarse: boolean) =>
          moveCutTo(idx, cut + dir * (coarse ? TRIM_NUDGE_COARSE_SEC : TRIM_NUDGE_SEC)),
      }))
    : []

  const previewSeg = (i: number) => {
    const { start, end } = segBounds(i)
    setActiveSeg(i)
    setTrim(start, end)
    seek(start)
    void play()
  }

  const [saving, setSaving] = useState(false)
  const onSave = useCallback(async () => {
    if (!cuts || saving) return
    setSaving(true)
    try {
      pause()
      for (let i = 0; i < n; i++) {
        const start = i === 0 ? 0 : cuts[i - 1]
        const end = i === n - 1 ? duration : cuts[i]
        const cell = cells[i]
        // Durable, cross-device: this cell's slice of the shared clip. The
        // generator already attached that clip to every one of these cells,
        // untrimmed, so the row exists and only its window is in question.
        //
        // 2026-08-14: this MUST be the trim event rather than a re-attach.
        // An attach can now only ever SET a window, never move one, so
        // re-adjusting boundaries a second time would have gone silently
        // nowhere — the first slice would have stuck forever.
        //
        // 2026-09-25: through the shared persist, which also paints each
        // slice at once. The per-line preference copy it used to write is
        // gone — every player reads the trim from the attachment now.
        void persistTakeTrim({
          projectId: project.id,
          fileId,
          cellId: cell.id,
          audioId,
          att: cell.attachments?.[audioId] ?? { url, voiceId, referenceAudioId },
          selectedAudioId: cell.selectedAudioId,
          trimStartMs: Math.round(start * 1000),
          trimEndMs: Math.round(end * 1000),
          author: username,
        })
      }
      onSaved?.()
      onClose()
    } finally {
      setSaving(false)
    }
  }, [cuts, saving, n, duration, cells, project.id, fileId, audioId, url, voiceId, referenceAudioId, username, pause, onSaved, onClose])


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("audio.boundaryEditor.title")}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X />
          </Button>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          {t("audio.boundaryEditor.description")}
        </p>

        {/* The combined clip, drawn as a timeline chip, one split line per
            boundary. Click a part to hear that line. */}
        <WaveformRect
          peaks={peaks}
          height={72}
          // A generated voice on the file's dub track, in that track's colour.
          kind="generated"
          trackVars={takeTrackVars({ files: project.files, fileId, slot: "generatedVoice" })}
          playing={isPlaying}
          progress={duration > 0 ? currentTime / duration : null}
          onTogglePlay={() => { if (isPlaying) pause(); else void play() }}
          playLabel={t("editor.audio.play")}
          stopLabel={t("common.pause")}
          edges={edges}
          status={duration <= 0 ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> {t("audio.boundaryEditor.loadingClip")}
            </span>
          ) : undefined}
          testId="boundary-waveform"
        >
          {/* Segment hit-areas (click to preview), under the split lines. */}
          {cuts && duration > 0 && cells.map((_, i) => {
            const { start, end } = segBounds(i)
            return (
              <AppTooltip key={i} content={t("audio.boundaryEditor.previewSegment", { snippet: snippet(cells[i], i) })}>
                <button
                  type="button"
                  onClick={() => previewSeg(i)}
                  className={cn(
                    "absolute inset-y-0 transition-colors",
                    activeSeg === i ? "bg-foreground/[0.08]" : i % 2 ? "bg-foreground/[0.03]" : "bg-transparent",
                    "hover:bg-foreground/[0.06]",
                  )}
                  style={{ left: `${(start / duration) * 100}%`, width: `${((end - start) / duration) * 100}%` }}
                />
              </AppTooltip>
            )
          })}
        </WaveformRect>

        {/* Per-line list with durations. */}
        <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto text-xs">
          {cells.map((c, i) => {
            const { start, end } = segBounds(i)
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => previewSeg(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-start hover:bg-accent/50",
                    activeSeg === i && "bg-primary/10",
                  )}
                >
                  {activeSeg === i && isPlaying ? <Pause className="h-3 w-3 shrink-0" /> : <Play className="h-3 w-3 shrink-0" />}
                  <span className="flex-1 truncate">{snippet(c, i)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmt(Math.max(0, end - start))}</span>
                </button>
              </li>
            )
          })}
        </ul>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
          <Button type="button" size="sm" onClick={() => void onSave()} disabled={saving || !cuts}>
            {saving ? <Spinner className="me-1 size-3.5" /> : null}
            {t("audio.boundaryEditor.saveSplits")}
          </Button>
        </div>
      </div>
    </div>
  )
}
