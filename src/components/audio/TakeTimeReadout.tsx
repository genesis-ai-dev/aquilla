// The running time over a take's waveform — "0:01 / 0:03" in its bottom-left
// corner — over the part that plays (the whole clip when untrimmed). One piece
// for the Audio view card and the Recording tab's top take (Sam, 2026-09-29),
// so the two read alike.

import type { KeptWindow } from "@/lib/audio/kept-window"
import { WAVE_OVERLAY_CLASS } from "./chip-classes"
import { cn } from "@/lib/utils"

function fmtTakeTime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

export function TakeTimeReadout({
  currentTime,
  duration,
  kept,
  testId,
}: {
  currentTime: number
  duration: number
  kept: Pick<KeptWindow, "start" | "end">
  testId?: string
}) {
  const start = kept.start ?? 0
  const end = kept.end ?? duration
  const length = Math.max(0, end - start)
  const at = Math.max(0, Math.min(currentTime - start, length))
  return (
    <span
      data-wave-overlay=""
      data-testid={testId}
      className={cn("rounded bg-background/70 px-1 text-[10px] tabular-nums text-muted-foreground", WAVE_OVERLAY_CLASS)}
    >
      {`${fmtTakeTime(at)} / ${length > 0 ? fmtTakeTime(length) : "–:––"}`}
    </span>
  )
}
