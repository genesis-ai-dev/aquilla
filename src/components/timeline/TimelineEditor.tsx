// The timeline editor: composes the lanes, ruler, playhead, video preview, and
// detail pane into the Media-lens surface. Owns zoom (persisted per file),
// horizontal scroll/windowing, selection, and the master clock. Hand-rolled;
// the only "media" dependency is a native <video> element for the linked-URL
// preview (the remote host serves Range — no streaming work needed here).

import { useMemo, useRef, useState } from "react"
import { Film, Minus, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { deriveLanes } from "@/lib/timeline/lanes"
import { timelineBounds } from "@/lib/timeline/derive"
import { secToPx, pxToSec, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from "@/lib/timeline/scale"
import { TimelineRuler } from "./TimelineRuler"
import { TimelineLane } from "./TimelineLane"
import { TimelinePlayhead } from "./TimelinePlayhead"
import { TimelineCellDetail } from "./TimelineCellDetail"
import { useTimelineClock } from "./useTimelineClock"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import type { ProjectRecord, RuleInfraction } from "@/lib/parsers/types"

export interface TimelineEditorProps {
  cells: CellData[]
  coreMediaUrl: string | null
  editable: boolean
  /** Used to scope the persisted zoom preference. */
  fileId: string
  onRetime(cellId: string, startSec: number, endSec: number): void
  onCommitTarget(cellId: string, value: string, valueHtml?: string): void
  /** When provided, shows a "Link video" control. null clears the link. */
  onLinkVideo?(url: string | null): void
  /** Forwarded to the clip detail pane so it can resolve/stream source audio. */
  project?: ProjectRecord
  /** Active managed terminology concepts for the detail-pane editor's chips. */
  terminologyConcepts?: Concept[]
  /** Per-cell rule infractions (keyed by cell id) for the detail-pane blots. */
  infractions?: Map<string, RuleInfraction[]>
}

const zoomKey = (fileId: string) => `codex:timelineZoom:${fileId}`

function loadZoom(fileId: string): number {
  try {
    const v = Number(localStorage.getItem(zoomKey(fileId)))
    return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : ZOOM_DEFAULT
  } catch {
    return ZOOM_DEFAULT
  }
}

function LaneLabel({ name, sub, dot }: { name: string; sub: string; dot: string }) {
  return (
    <div className="flex h-[66px] flex-col justify-center gap-0.5 border-b border-border px-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <span className={cn("h-1.5 w-1.5 rounded-sm", dot)} />
        {name}
      </span>
      <span className="text-[10px] text-muted-foreground">{sub}</span>
    </div>
  )
}

export function TimelineEditor({
  cells,
  coreMediaUrl,
  editable,
  fileId,
  onRetime,
  onCommitTarget,
  onLinkVideo,
  project,
  terminologyConcepts,
  infractions,
}: TimelineEditorProps) {
  const [pxPerSec, setPxPerSec] = useState(() => loadZoom(fileId))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportPx, setViewportPx] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const clock = useTimelineClock()

  const { subtitle, dialogue, untimed } = useMemo(() => deriveLanes(cells), [cells])
  const bounds = useMemo(() => timelineBounds(cells), [cells])
  const durationSec = (bounds?.end ?? 0) + 2
  const trackWidthPx = secToPx(durationSec, pxPerSec)
  const viewStartSec = pxToSec(scrollLeft, pxPerSec)
  // Before the scroll container is measured (viewportPx 0), fall back to the
  // full track so every card renders — correct, and keeps tests deterministic.
  const viewEndSec = pxToSec(scrollLeft + (viewportPx || trackWidthPx), pxPerSec)
  const selectedCell = useMemo(
    () => cells.find((c) => c.id === selectedId) ?? null,
    [cells, selectedId],
  )

  function applyZoom(next: number) {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next))
    setPxPerSec(z)
    try {
      localStorage.setItem(zoomKey(fileId), String(z))
    } catch {
      /* private mode / unavailable — zoom just won't persist */
    }
  }

  function seekTo(sec: number) {
    clock.seekTo(sec)
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = Math.max(0, sec)
      } catch {
        /* not seekable yet */
      }
    }
  }

  const laneProps = {
    pxPerSec,
    viewStartSec,
    viewEndSec,
    selectedId,
    editable,
    onSelect: setSelectedId,
    onRetime,
  }

  return (
    <div data-testid="tl-editor" className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">Timeline</span>
        <div className="ml-auto flex items-center gap-1.5">
          {onLinkVideo && (
            <button
              type="button"
              onClick={() => {
                const u = window.prompt("Core video URL (leave blank to clear)", coreMediaUrl ?? "")
                if (u !== null) onLinkVideo(u.trim() || null)
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground/80 hover:bg-muted"
            >
              <Film className="h-3.5 w-3.5 text-muted-foreground" />
              {coreMediaUrl ? "Change video" : "Link video"}
            </button>
          )}
          <div className="inline-flex items-center rounded-md border border-border">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => applyZoom(pxPerSec / 1.3)}
              className="px-1.5 py-1 text-foreground/70 hover:bg-muted"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="border-x border-border px-2 font-mono text-[11px] tabular-nums text-muted-foreground">
              {(pxPerSec / ZOOM_DEFAULT).toFixed(1)}×
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => applyZoom(pxPerSec * 1.3)}
              className="px-1.5 py-1 text-foreground/70 hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* linked-URL video preview (master clock) */}
      {coreMediaUrl && (
        <div className="flex justify-center border-b border-border bg-black">
          <video
            ref={videoRef}
            src={coreMediaUrl}
            controls
            data-testid="tl-video"
            onTimeUpdate={(e) => clock.setCurrentSec(e.currentTarget.currentTime)}
            className="max-h-[240px] w-auto"
          />
        </div>
      )}

      {/* timeline */}
      <div className="grid min-h-0 grid-cols-[128px_1fr]">
        <div className="border-r border-border bg-muted/20">
          <div className="h-7 border-b border-border" />
          <LaneLabel name="Subtitle" sub="text · reading" dot="bg-zinc-400 dark:bg-zinc-600" />
          <LaneLabel name="Dialogue" sub="audio · recording" dot="bg-sky-600" />
          <div className="flex h-12 flex-col justify-center px-3">
            <span className="text-xs font-semibold text-foreground">Untimed</span>
            <span className="text-[10px] text-muted-foreground">no timecode</span>
          </div>
        </div>
        <div
          className="overflow-x-auto"
          onScroll={(e) => {
            setScrollLeft(e.currentTarget.scrollLeft)
            setViewportPx(e.currentTarget.clientWidth)
          }}
        >
          <div className="relative" style={{ width: `${trackWidthPx}px` }}>
            <TimelineRuler durationSec={durationSec} pxPerSec={pxPerSec} onScrub={seekTo} />
            <TimelineLane cells={subtitle} variant="subtitle" {...laneProps} />
            <TimelineLane cells={dialogue} variant="dialogue" {...laneProps} />
            <div className="flex h-12 items-center gap-2 overflow-x-auto border-b border-border px-3">
              {untimed.length === 0 ? (
                <span className="text-[10px] text-muted-foreground">No untimed clips.</span>
              ) : (
                untimed.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`tl-untimed-${c.id}`}
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "shrink-0 rounded-md border border-dashed border-zinc-400 bg-background px-2 py-1 text-[10px] text-foreground/80 hover:bg-muted dark:border-zinc-600",
                      selectedId === c.id && "ring-2 ring-sky-500",
                    )}
                  >
                    {(c.original || c.transcription || c.cellLabel || "untimed").slice(0, 36)}
                  </button>
                ))
              )}
            </div>
            <TimelinePlayhead currentSec={clock.currentSec} pxPerSec={pxPerSec} />
          </div>
        </div>
      </div>

      <TimelineCellDetail
        cell={selectedCell}
        editable={editable}
        onCommitTarget={onCommitTarget}
        project={project}
        terminologyConcepts={terminologyConcepts}
        infractions={selectedCell ? infractions?.get(selectedCell.id) : undefined}
      />
    </div>
  )
}
