// The per-line speaker chip: shows the assigned voice's avatar + name and opens
// a picker to reassign. Shared by the editor's Audio lens per-line control so a
// line's character reads identically with the Voices panel (same avatar orbs).

import { Check } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
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
            title="Assign a voice to this line"
            className="flex max-w-[11rem] shrink-0 items-center gap-1.5 rounded-full border bg-background py-0.5 pl-0.5 pr-2 text-xs transition-colors hover:bg-accent/50"
          >
            <VoiceAvatar voice={voice} size={20} />
            <span className="truncate">{voice?.name ?? "Unassigned"}</span>
          </button>
        }
      />
      <PopoverContent align="start" side="bottom" className="w-56 p-1">
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
              <VoiceAvatar voice={v} size={22} />
              <span className="flex-1 truncate">{v.name}</span>
              {v.id === voice?.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
