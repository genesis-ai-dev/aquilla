// Segmented "Text | Audio" lens switch in the workspace header. Both lenses are
// the SAME editor over the SAME cell list — toggling is local state, not a
// route change — so scroll position and selection are preserved. Text mode is
// plain translation; Audio mode reveals the cast library, transport, per-line
// speaker chips and generate controls (the old standalone Voice Studio).

import { Mic2, Pencil, AudioWaveform } from "lucide-react"
import { cn } from "@/lib/utils"

export type EditorLens = "text" | "audio"

interface Props {
  lens: EditorLens
  onChange: (lens: EditorLens) => void
  /** Timeline-segment-model: when true the active file is time-ordered, so the
   *  second lens selects the MEDIA layer (separate media segments) rather than
   *  audio-attachments on the same text cells. Relabels "Audio" → "Media". */
  timeOrdered?: boolean
}

export function EditorModeToggle({ lens, onChange, timeOrdered = false }: Props) {
  const secondLabel = timeOrdered ? "Media" : "Audio"
  const SecondIcon = timeOrdered ? AudioWaveform : Mic2
  return (
    <div className="neu-inset flex items-center gap-0.5 rounded-full p-1 text-xs">
      <button
        type="button"
        onClick={() => lens !== "text" && onChange("text")}
        className={cn(
          "flex items-center gap-1 rounded-full px-2.5 py-1 transition-all",
          lens === "text"
            ? "bg-card font-medium text-foreground shadow-neu-xs"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={lens === "text"}
      >
        <Pencil className="h-3 w-3" /> Text
      </button>
      <button
        type="button"
        onClick={() => lens !== "audio" && onChange("audio")}
        className={cn(
          "flex items-center gap-1 rounded-full px-2.5 py-1 transition-all",
          lens === "audio"
            ? "bg-card font-medium text-foreground shadow-neu-xs"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={lens === "audio"}
      >
        <SecondIcon className="h-3 w-3" /> {secondLabel}
      </button>
    </div>
  )
}
