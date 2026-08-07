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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Pause, Play, X } from "lucide-react"
import { CellWaveform } from "@/components/CellWaveform"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useCellAudio } from "@/hooks/useCellAudio"
import { setCellPref } from "@/lib/store/audio-cell-prefs"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"

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
  const { duration, isPlaying, currentTime, seek, play, pause, setTrim } = audio

  // The <CellWaveform> below (strategy="eager") decodes peaks on mount, which
  // also yields `duration` — so we don't issue a second, differently-binned
  // requestPeaks here (two concurrent decodes raced and surfaced a spurious
  // "Retry waveform" even when one succeeded).

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

  const boxRef = useRef<HTMLDivElement | null>(null)
  const fracFromX = (clientX: number): number => {
    const el = boxRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1)
  }

  const segBounds = useCallback((i: number): { start: number; end: number } => {
    const c = cuts ?? []
    const start = i === 0 ? 0 : c[i - 1] ?? 0
    const end = i === n - 1 ? duration : c[i] ?? duration
    return { start, end }
  }, [cuts, n, duration])

  const moveCut = (idx: number, clientX: number) => {
    if (!cuts || duration <= 0) return
    const t = fracFromX(clientX) * duration
    const lo = (idx === 0 ? 0 : cuts[idx - 1]) + 0.05
    const hi = (idx === n - 2 ? duration : cuts[idx + 1]) - 0.05
    const next = cuts.slice()
    next[idx] = clamp(t, lo, hi)
    setCuts(next)
  }

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
        // Live cache the player reads.
        setCellPref(project.id, cell.id, { trimStart: start, trimEnd: end })
        // Durable, cross-device: re-attach the shared clip with this slice.
        void emitCellAudioAttach({
          projectId: project.id,
          fileId,
          cellId: cell.id,
          audioId,
          url,
          slot: "generatedVoice",
          mimeType: "audio/wav",
          voiceId,
          ...(referenceAudioId ? { referenceAudioId } : {}),
          trimStartMs: Math.round(start * 1000),
          trimEndMs: Math.round(end * 1000),
          author: username,
        })
      }
      notifyAudioAttachmentsChanged(fileId)
      onSaved?.()
      onClose()
    } finally {
      setSaving(false)
    }
  }, [cuts, saving, n, duration, cells, project.id, fileId, audioId, url, voiceId, referenceAudioId, username, pause, onSaved, onClose])

  const playheadPct = duration > 0 ? clamp(currentTime / duration, 0, 1) * 100 : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Split the combined clip by line</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Drag the dividers so each marker sits at the end of a line. Click a segment to hear just that line.
          Defaults to an even split by text length.
        </p>

        {/* Waveform + dividers. */}
        <div ref={boxRef} className="relative select-none">
          <CellWaveform controller={audio} height={72} strategy="eager" />

          {/* Playhead. */}
          {duration > 0 && (
            <div className="pointer-events-none absolute inset-y-0 w-px bg-primary/70" style={{ left: `${playheadPct}%` }} aria-hidden />
          )}

          {/* Segment hit-areas (click to preview) with alternating tint. */}
          {cuts && duration > 0 && cells.map((_, i) => {
            const { start, end } = segBounds(i)
            const leftPct = (start / duration) * 100
            const widthPct = ((end - start) / duration) * 100
            return (
              <AppTooltip key={i} content={`Preview ${snippet(cells[i], i)}`}>
                <button
                  type="button"
                  onClick={() => previewSeg(i)}
                  className={cn(
                    "absolute inset-y-0 border-l border-transparent transition-colors",
                    activeSeg === i ? "bg-primary/15" : i % 2 ? "bg-foreground/[0.03]" : "bg-transparent",
                    "hover:bg-primary/10",
                  )}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
              </AppTooltip>
            )
          })}

          {/* Draggable dividers. */}
          {cuts && duration > 0 && cuts.map((t, idx) => {
            const leftPct = (t / duration) * 100
            return (
              <div
                key={idx}
                role="slider"
                aria-label={`Divider ${idx + 1}`}
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(t)}
                onPointerDown={(e) => {
                  e.preventDefault(); e.stopPropagation()
                  e.currentTarget.setPointerCapture?.(e.pointerId)
                  moveCut(idx, e.clientX)
                }}
                onPointerMove={(e) => { if (e.buttons === 1) { e.stopPropagation(); moveCut(idx, e.clientX) } }}
                className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-ew-resize touch-none"
                style={{ left: `${leftPct}%` }}
              >
                <div className="mx-auto h-full w-0.5 bg-primary" />
                <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-primary" />
              </div>
            )
          })}

          {duration <= 0 && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Loading clip…
            </div>
          )}
        </div>

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
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent/50",
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
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" size="sm" onClick={() => void onSave()} disabled={saving || !cuts}>
            {saving ? <Spinner className="mr-1 size-3.5" /> : null}
            Save splits
          </Button>
        </div>
      </div>
    </div>
  )
}
