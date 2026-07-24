// The Target-audio track (round 5): one chip per media section that has dub
// audio — a recorded take (mic icon) or a generated voice (sparkles). A chip
// sits exactly at its section's window; its timing IS the section's timing,
// so there is no drag/retime here — retime the section on the Source track.

import { Mic, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { isVisible, secToPx } from "@/lib/timeline/scale"
import type { CellData } from "@/hooks/useCells"

export interface TargetAudioItem {
  cell: CellData
  kind: "take" | "generated"
}

export interface TargetAudioLaneProps {
  /** Already derived + time-sorted (from the dialogue lane). */
  items: TargetAudioItem[]
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  onSelect(id: string): void
  /** Clean chip click navigates playback to the section (same as a card). */
  onSeek?(id: string): void
}

function TargetAudioChip({
  cell,
  kind,
  pxPerSec,
  selected,
  onSelect,
  onSeek,
}: {
  cell: CellData
  kind: "take" | "generated"
  pxPerSec: number
  selected: boolean
  onSelect(id: string): void
  onSeek?(id: string): void
}) {
  const startSec = cell.startTime ?? 0
  const endSec = cell.endTime ?? startSec
  const left = secToPx(startSec, pxPerSec)
  const width = Math.max(10, secToPx(endSec - startSec, pxPerSec))
  const Icon = kind === "take" ? Mic : Sparkles
  return (
    <button
      type="button"
      data-testid={`tl-target-${cell.id}`}
      data-kind={kind}
      title={kind === "take" ? "Recorded take" : "Generated voice"}
      onClick={() => {
        onSelect(cell.id)
        onSeek?.(cell.id)
      }}
      style={{ left: `${left}px`, width: `${width}px` }}
      className={cn(
        "absolute top-2.5 flex h-[46px] items-center justify-center overflow-hidden rounded-md border",
        kind === "take"
          ? "border-emerald-500/60 bg-emerald-100/80 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
          : "border-violet-500/60 bg-violet-100/80 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300",
        "hover:brightness-105",
        selected && "ring-2 ring-sky-500",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
    </button>
  )
}

export function TargetAudioLane({
  items,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  onSelect,
  onSeek,
}: TargetAudioLaneProps) {
  const visible = items.filter(({ cell }) =>
    isVisible(cell.startTime ?? 0, cell.endTime ?? cell.startTime ?? 0, viewStartSec, viewEndSec),
  )
  return (
    <div data-testid="tl-target-lane" className="relative h-[66px] border-b border-border">
      {visible.map(({ cell, kind }) => (
        <TargetAudioChip
          key={cell.id}
          cell={cell}
          kind={kind}
          pxPerSec={pxPerSec}
          selected={selectedId === cell.id}
          onSelect={onSelect}
          onSeek={onSeek}
        />
      ))}
    </div>
  )
}
