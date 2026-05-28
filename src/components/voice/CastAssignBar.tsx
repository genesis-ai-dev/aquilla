// Bottom bar shown while lines are multi-selected in the editor's Audio lens:
// assign them all to one character in a single action. Reads the shared
// selection store directly so the host only has to render it.

import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { clearSelection, useSelectedIds } from "@/lib/audio/selection"
import type { Voice } from "@/lib/parsers/types"

export function CastAssignBar({ voices, activeCastId, onAssign }: {
  voices: Voice[]
  /** Highlighted "one-click assign" target (the active cast member in the rail). */
  activeCastId?: string
  onAssign: (cellIds: Iterable<string>, voiceId: string) => void
}) {
  const selectedIds = useSelectedIds()
  if (selectedIds.size === 0) return null

  const count = selectedIds.size
  const active = voices.find((v) => v.id === activeCastId)
  const assign = (voiceId: string) => { onAssign(selectedIds, voiceId); clearSelection() }

  return (
    <div className="flex items-center gap-3 border-t bg-background px-4 py-2">
      <span className="text-sm font-medium tabular-nums">{count} selected</span>
      <span className="text-xs text-muted-foreground">Assign to</span>
      {active ? (
        <Button size="sm" className="h-8" onClick={() => assign(active.id)}>
          <span className="mr-1.5 h-2.5 w-2.5 rounded-full border" style={{ backgroundColor: active.color || "#94a3b8" }} />
          {active.name}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground/70">pick a character →</span>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {voices.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => assign(v.id)}
            title={`Assign ${count} line(s) to ${v.name}`}
            className="flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-xs hover:bg-accent/50"
          >
            <span className="h-2.5 w-2.5 rounded-full border" style={{ backgroundColor: v.color || "#94a3b8" }} />
            <span className="max-w-[7rem] truncate">{v.name}</span>
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" className="h-8" onClick={() => clearSelection()}>
        <X className="mr-1 h-3.5 w-3.5" /> Clear
      </Button>
    </div>
  )
}
