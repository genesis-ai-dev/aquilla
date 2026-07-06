// Per-cell, non-destructive crop. A Scissors button opens a popover with the
// clip's waveform and two drag handles; the selected [start,end] window is
// stored in audio-cell-prefs (trimStart/trimEnd) and applied on playback by
// useCellAudio — nothing is re-encoded. Dragging a handle to the clip edge
// clears that bound (null); both cleared = no trim.

import { useRef } from "react"
import { Pause, Play, RotateCcw, Scissors } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CellWaveform } from "@/components/CellWaveform"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function fmt(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

export interface CropTrim {
  start: number | null
  end: number | null
}

export function CropButton({
  controller, trim, onChange,
}: {
  controller: UseCellAudioResult
  trim: CropTrim
  onChange: (start: number | null, end: number | null) => void
}) {
  const trimmed = trim.start != null || trim.end != null
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Crop audio"
            className={cn("shrink-0", trimmed ? "text-foreground" : undefined)}
          >
            <Scissors className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-80 p-3">
        <CropPanel controller={controller} trim={trim} onChange={onChange} />
      </PopoverContent>
    </Popover>
  )
}

function CropPanel({ controller, trim, onChange }: {
  controller: UseCellAudioResult
  trim: CropTrim
  onChange: (start: number | null, end: number | null) => void
}) {
  const { duration, isPlaying, play, pause } = controller
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dur = duration > 0 ? duration : 0
  const start = trim.start ?? 0
  const end = trim.end ?? dur
  const startFrac = dur > 0 ? clamp01(start / dur) : 0
  const endFrac = dur > 0 ? clamp01(end / dur) : 1

  const MIN_GAP = 0.15 // seconds between handles

  const fracFromX = (clientX: number): number => {
    const el = boxRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp01((clientX - r.left) / Math.max(1, r.width))
  }

  const moveStart = (clientX: number) => {
    if (dur <= 0) return
    const t = Math.min(Math.max(0, fracFromX(clientX) * dur), end - MIN_GAP)
    onChange(t <= 0.02 ? null : t, trim.end)
  }
  const moveEnd = (clientX: number) => {
    if (dur <= 0) return
    const t = Math.max(Math.min(dur, fracFromX(clientX) * dur), start + MIN_GAP)
    onChange(trim.start, t >= dur - 0.02 ? null : t)
  }

  const handleProps = (mover: (x: number) => void) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      mover(e.clientX)
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1) return
      e.stopPropagation()
      mover(e.clientX)
    },
  })

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Crop</span>
        <button
          type="button"
          onClick={() => onChange(null, null)}
          aria-label="Reset to full clip"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
      </div>

      <div ref={boxRef} className="relative">
        <CellWaveform controller={controller} height={56} strategy="eager" />
        {/* Dim the regions outside the selection (clicks pass through to seek). */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded-l-xl bg-background/65"
          style={{ width: `${startFrac * 100}%` }}
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 rounded-r-xl bg-background/65"
          style={{ width: `${(1 - endFrac) * 100}%` }}
          aria-hidden
        />
        {/* Drag handles. */}
        <div
          {...handleProps(moveStart)}
          role="slider"
          aria-label="Crop start"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(start)}
          className="absolute inset-y-0 z-10 w-2.5 -translate-x-1/2 cursor-ew-resize touch-none"
          style={{ left: `${startFrac * 100}%` }}
        >
          <div className="mx-auto h-full w-0.5 bg-primary" />
        </div>
        <div
          {...handleProps(moveEnd)}
          role="slider"
          aria-label="Crop end"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(end)}
          className="absolute inset-y-0 z-10 w-2.5 -translate-x-1/2 cursor-ew-resize touch-none"
          style={{ left: `${endFrac * 100}%` }}
        >
          <div className="mx-auto h-full w-0.5 bg-primary" />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => { if (isPlaying) pause(); else void play() }}
        >
          {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {isPlaying ? "Pause" : "Preview"}
        </Button>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {fmt(start)} – {dur > 0 ? fmt(end) : "–:––"} · {fmt(Math.max(0, end - start))}
        </span>
      </div>
    </div>
  )
}
