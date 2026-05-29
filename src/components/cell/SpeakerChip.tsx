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
            title="Assign a character to this line"
            className="flex max-w-[9rem] shrink-0 items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-xs hover:bg-accent/50"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ backgroundColor: voice?.color || "#94a3b8" }} />
            <span className="truncate">{voice?.name ?? "Unassigned"}</span>
            {voice?.referenceAudioId && <Sparkles className="h-2.5 w-2.5 shrink-0 text-violet-500" />}
          </button>
        }
      />
      <PopoverContent align="end" side="bottom" className="w-52 p-1">
        {(() => {
          const synthetic = voices.filter((v) => !v.referenceAudioId)
          const cloned = voices.filter((v) => v.referenceAudioId)
          const row = (v: Voice) => (
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
              {v.referenceAudioId && <Sparkles className="h-3 w-3 shrink-0 text-violet-500" />}
            </button>
          )
          return (
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Voices
              </p>
              {synthetic.map(row)}
              {cloned.length > 0 && (
                <>
                  <p className="mt-1 flex items-center gap-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">
                    <Sparkles className="h-2.5 w-2.5" /> Cloned characters
                  </p>
                  {cloned.map(row)}
                </>
              )}
            </div>
          )
        })()}
      </PopoverContent>
    </Popover>
  )
}
