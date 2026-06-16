// The per-line speaker chip: shows the assigned cast member's color + name and
// opens a picker to reassign. Shared by the editor's Audio lens and (formerly)
// the Voice Studio production row so a line's character reads identically in
// both. Mirrors the cast colors used in the voice library.

import { Sparkles } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { Voice } from "@/lib/parsers/types"

export function SpeakerChip({ voice, voices, onAssign }: {
  voice: Voice | undefined
  voices: Voice[]
  onAssign: (voiceId: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex max-w-[9rem] shrink-0 items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-xs hover:bg-accent/50"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ backgroundColor: voice?.color || "#94a3b8" }} />
            <span className="truncate">{voice?.name ?? "Unassigned"}</span>
            {voice?.referenceAudioId && <Sparkles className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
          </button>
        }
      />
      <PopoverContent align="end" side="bottom" className="w-52 p-1">
        {/* One flat list — every voice is the same primitive. A voice with a
            clone reference keeps its square dot + violet sparkle marker so it's
            still recognizable, but there's no separate group. */}
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {voices.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onAssign(v.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50",
                v.id === voice?.id && "bg-primary/10",
              )}
            >
              <span
                className={cn("h-2.5 w-2.5 shrink-0 border", v.referenceAudioId ? "rounded-sm" : "rounded-full")}
                style={{ backgroundColor: v.color || "#94a3b8" }}
              />
              <span className="flex-1 truncate">{v.name}</span>
              {v.referenceAudioId && <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
