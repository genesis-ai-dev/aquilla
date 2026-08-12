// Segmented "Text | Audio" lens switch in the chapter navigation row (beside
// Check file). Both lenses read the SAME cell list. For non-time-ordered files the toggle is local
// state over one mounted editor, so scroll/selection carry over directly; for
// time-ordered (media) files the editors swap and the workspace TRACES the
// current cell across the switch instead (AQU-646 — media→text scrolls+flashes
// the row, text→media selects/centers/cues the clip). Text mode is plain
// translation; Audio mode reveals the cast library, transport, per-line
// speaker chips and generate controls (the old standalone Voice Studio).

import { Mic2, Pencil, AudioWaveform } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { audioLensLabelKey } from "@/lib/editor/audio-lens-label"
import { useT } from "@/lib/i18n/I18nProvider"

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
  const t = useT()
  // AQU-353: the canonical lens label is shared with every other entry point
  // that toggles this lens (e.g. the sidebar "More" item) via audioLensLabelKey,
  // so they never diverge (this used to say "Audio" while the sidebar said
  // "Voice"). The icon pair is kept in lockstep with audioLensIcon (see its
  // test); it stays inline here as a stable component ref so it can be used as
  // JSX.
  const secondLabel = t(audioLensLabelKey(timeOrdered))
  const SecondIcon = timeOrdered ? AudioWaveform : Mic2
  return (
    <Tabs
      value={lens}
      onValueChange={(value) => onChange(value as EditorLens)}
      className="gap-0"
    >
      <TabsList>
        <TabsTrigger value="text" aria-label={t("editor.lens.text")}>
          <Pencil />
          <span className="hidden lg:inline">{t("editor.lens.text")}</span>
        </TabsTrigger>
        <TabsTrigger value="audio" aria-label={secondLabel}>
          <SecondIcon />
          <span className="hidden lg:inline">{secondLabel}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
