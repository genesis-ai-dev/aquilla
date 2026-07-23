// The Audio lens' global playback bar, pinned at the bottom of the workspace.
// One transport for the whole file: play-all walks every line in order (via the
// shared play-queue), with prev/next, a scrubbable progress line, speed, and
// volume. It mirrors ElevenLabs' bottom player — the per-line buttons stay for
// voicing a single line, but listening to the take in sequence happens here.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Pause, Play, SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { cn } from "@/lib/utils"
import {
  hasAnyPlayableAudio, pauseQueue, resumeQueue, seekQueue, setQueueRate, setQueueVolume,
  skipBack, skipForward, startQueue, updateQueueCells, useQueueProgress, useQueueState,
} from "@/lib/audio/play-queue"
import { spacebarShouldToggle } from "@/lib/audio/playback-keys"
import { resolveCastVoice } from "@/lib/audio/voices"
import { useFileAudioAttachments, mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

interface Props {
  cells: CellData[]
  projectId: string
  session: FrontierSession | null
  settings: ProjectTtsSettings | undefined
  /** Scroll a line into view when the queue advances to it. */
  onActiveCell?: (cellId: string) => void
  /** The highlighted section (e.g. selected on the Dialogue timeline). When
   *  set, pressing Play starts from this section instead of the file's start
   *  (AQU-666). */
  startCellId?: string | null
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

export function VoicePlaybackBar({ cells: rawCells, projectId, session, settings, onActiveCell, startCellId }: Props) {
  const queue = useQueueState()
  const { currentTime, duration, rate, volume } = useQueueProgress()

  // The cells handed down from useCells carry no audio attachments — those are
  // read per-file by useFileAudioAttachments and merged in (the editor table
  // does the same). Hydrating here keeps the player subscribed to the audio
  // bus, so generating/recording a take flips "No voiced lines yet" at once
  // instead of staying stale until reload.
  const fileId = rawCells[0]?.fileId ?? null
  const { byCellId: audioByCellId } = useFileAudioAttachments(projectId, fileId)
  const cells = useMemo(
    () => mergeCellsWithAudio(rawCells, audioByCellId),
    [rawCells, audioByCellId],
  )

  const canPlay = useMemo(() => hasAnyPlayableAudio(cells), [cells])
  const activeIndex =
    queue.kind === "playing" || queue.kind === "paused" || queue.kind === "loading"
      ? queue.cellIndex
      : -1
  const activeCell = activeIndex >= 0 ? cells[activeIndex] : undefined
  const activeVoice = activeCell ? resolveCastVoice(settings, activeCell.id) : undefined

  // Keep the running queue's snapshot fresh so a mid-playback generate is heard
  // on the next advance.
  useEffect(() => {
    if (queue.kind !== "idle") updateQueueCells(cells)
  }, [cells, queue.kind])

  const isPlaying = queue.kind === "playing"
  const isLoading = queue.kind === "loading"

  const startAt = useCallback((from: number) => {
    if (!session?.jwt) return
    startQueue({ cells, projectId, session, onCellChange: (_, cellId) => onActiveCell?.(cellId) }, from)
  }, [cells, projectId, session, onActiveCell])

  const onPlayPause = useCallback(() => {
    if (isPlaying) { pauseQueue(); return }
    if (queue.kind === "paused") { void resumeQueue(); return }
    // Start from the highlighted section when one is selected, else the top of
    // the file (AQU-666). The queue skips forward from here to the next cell
    // that actually has audio, so an unplayable pick still behaves.
    const from = startCellId ? cells.findIndex((c) => c.id === startCellId) : -1
    startAt(from >= 0 ? from : 0)
  }, [isPlaying, queue.kind, startAt, cells, startCellId])

  // Spacebar toggles play/pause while the Audio-lens bar is mounted (this bar
  // only renders in the audio lens, so the binding is naturally scoped to it).
  // The predicate ignores the key when the user is typing or a control is
  // focused, so editing a line or clicking a button keeps Space's normal effect.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!spacebarShouldToggle(e) || !canPlay) return
      e.preventDefault()
      onPlayPause()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [canPlay, onPlayPause])

  const progressFraction = duration > 0 ? Math.min(1, currentTime / duration) : 0

  return (
    <div className="border-t bg-background">
      {/* Full-width progress line doubling as a scrubber. */}
      <BarScrubber
        fraction={progressFraction}
        disabled={activeIndex < 0 || duration <= 0}
        onSeek={(f) => seekQueue(f * duration)}
      />

      <div className="flex items-center gap-3 px-4 py-1.5">
        {/* Now playing */}
        <div className="flex min-w-0 flex-[1.2] items-center gap-2">
          {activeVoice && <VoiceAvatar voice={activeVoice} size={26} />}
          <div className="min-w-0">
            <div className="truncate text-xs font-medium leading-tight">
              {activeCell ? (activeCell.cellLabel || "Line") : "Nothing playing"}
            </div>
            <div className="truncate text-[10px] leading-tight text-muted-foreground">
              {queue.kind === "error"
                ? queue.message
                : activeVoice
                  ? activeVoice.name
                  : canPlay ? "Press play to listen" : "No voiced lines yet"}
            </div>
          </div>
        </div>

        {/* Transport */}
        <div className="flex shrink-0 items-center gap-1">
          <SpeedButton rate={rate} onChange={setQueueRate} />
          <IconButton title="Previous line" disabled={!canPlay} onClick={skipBack}>
            <SkipBack className="h-4 w-4" />
          </IconButton>
          <Button
            type="button"
            size="icon"
            variant="default"
            onClick={onPlayPause}
            disabled={!canPlay}
            title={isPlaying ? "Pause" : "Play all"}
            aria-label={isPlaying ? "Pause" : "Play all"}
            className="bg-foreground text-background hover:bg-foreground/90"
          >
            {isLoading ? <Spinner /> : isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
          </Button>
          <IconButton title="Next line" disabled={!canPlay} onClick={skipForward}>
            <SkipForward className="h-4 w-4" />
          </IconButton>
          <span className="ml-1 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {fmtTime(currentTime)} / {fmtTime(duration)}
          </span>
        </div>

        {/* Volume */}
        <div className="flex min-w-0 flex-1 items-center justify-end">
          <VolumeControl volume={volume} onChange={setQueueVolume} />
        </div>
      </div>
    </div>
  )
}

function IconButton({
  children, title, onClick, disabled,
}: {
  children: ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}

/** Thin full-width progress line that's draggable to seek. */
function BarScrubber({ fraction, onSeek, disabled }: {
  fraction: number
  onSeek: (f: number) => void
  disabled: boolean
}) {
  const fracFromEvent = (e: React.PointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)))
  }
  return (
    <div
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      onPointerDown={(e) => {
        if (disabled) return
        e.currentTarget.setPointerCapture?.(e.pointerId)
        onSeek(fracFromEvent(e))
      }}
      onPointerMove={(e) => { if (!disabled && e.buttons === 1) onSeek(fracFromEvent(e)) }}
      className={cn(
        "group/bar relative h-1 w-full touch-none bg-muted",
        disabled ? "cursor-default" : "cursor-pointer",
      )}
    >
      <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${fraction * 100}%` }} />
    </div>
  )
}

function SpeedButton({ rate, onChange }: { rate: number; onChange: (r: number) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            title="Playback speed"
            className="min-w-9 px-1.5 tabular-nums"
          >
            {rate}x
          </Button>
        }
      />
      <PopoverContent align="center" side="top" className="w-24 p-1">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { onChange(s); setOpen(false) }}
            className={cn(
              "flex w-full items-center justify-center rounded px-2 py-1 text-sm tabular-nums hover:bg-accent/50",
              s === rate && "bg-primary/10 font-medium",
            )}
          >
            {s}x
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function VolumeControl({ volume, onChange }: { volume: number; onChange: (v: number) => void }) {
  const muted = volume === 0
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
        onClick={() => onChange(muted ? 1 : 0)}
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </Button>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={[volume]}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        aria-label="Volume"
        className="hidden w-24 sm:block"
      />
    </div>
  )
}
