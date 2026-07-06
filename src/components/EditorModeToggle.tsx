// Segmented "Text | Audio" lens switch in the workspace header. Both lenses are
// the SAME editor over the SAME cell list — toggling is local state, not a
// route change — so scroll position and selection are preserved. Text mode is
// plain translation; Audio mode reveals the cast library, transport, per-line
// speaker chips and generate controls (the old standalone Voice Studio).

import { Mic2, Pencil, AudioWaveform } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

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
    <Tabs
      value={lens}
      onValueChange={(value) => onChange(value as EditorLens)}
      className="gap-0"
    >
      <TabsList>
        <TabsTrigger value="text">
          <Pencil /> Text
        </TabsTrigger>
        <TabsTrigger value="audio">
          <SecondIcon /> {secondLabel}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
