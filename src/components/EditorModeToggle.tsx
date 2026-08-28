// Text / Audio-or-Media / Agent switch in the chapter navigation row.
// Compact viewports stay icon-only with a tooltip; md+ (768px, same as the
// Check file control in this row) shows the label beside the icon.
// The editor lenses read the SAME cell list. For non-time-ordered files the toggle is local
// state over one mounted editor, so scroll/selection carry over directly; for
// time-ordered (media) files the editors swap and the workspace TRACES the
// current cell across the switch instead (AQU-646 — media→text scrolls+flashes
// the row, text→media selects/centers/cues the clip). Text mode is plain
// translation; Audio mode reveals the cast library, transport, per-line
// speaker chips and generate controls (the old standalone Voice Studio).

import { useSyncExternalStore, type ComponentType } from "react"
import { Mic2, Pencil, AudioWaveform, Bot } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { audioLensLabelKey } from "@/lib/editor/audio-lens-label"
import { useT } from "@/lib/i18n/I18nProvider"

export type EditorLens = "text" | "audio"

/** Tailwind `md` — at/above this, the mode labels sit beside the icons. */
const MD_MIN_WIDTH_QUERY = "(min-width: 768px)"

function useIsMdUp(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mq = window.matchMedia(MD_MIN_WIDTH_QUERY)
      mq.addEventListener("change", onStoreChange)
      return () => mq.removeEventListener("change", onStoreChange)
    },
    () => window.matchMedia(MD_MIN_WIDTH_QUERY).matches,
    () => true,
  )
}

interface Props {
  lens: EditorLens
  onChange: (lens: EditorLens) => void
  /** Open the full Agent workbench. Agent is a destination rather than a
   * persisted editor lens, so selecting it delegates navigation to the shell. */
  onAgentSelect?: () => void
  /** When the Agent workbench is showing, select the Agent tab so Text/Audio
   *  remain one click away. */
  agentActive?: boolean
  /** Timeline-segment-model: when true the active file is time-ordered, so the
   *  second lens selects the MEDIA layer (separate media segments) rather than
   *  audio-attachments on the same text cells. Relabels "Audio" → "Media". */
  timeOrdered?: boolean
}

export function EditorModeToggle({
  lens,
  onChange,
  onAgentSelect,
  agentActive = false,
  timeOrdered = false,
}: Props) {
  const t = useT()
  const labeled = useIsMdUp()
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
      value={agentActive ? "agent" : lens}
      onValueChange={(value) => {
        if (value === "agent") {
          onAgentSelect?.()
          return
        }
        onChange(value as EditorLens)
      }}
      className="gap-0"
    >
      <TabsList>
        <ModeTab value="text" label={t("editor.lens.text")} icon={Pencil} labeled={labeled} />
        <ModeTab value="audio" label={secondLabel} icon={SecondIcon} labeled={labeled} />
        {(onAgentSelect || agentActive) ? (
          <ModeTab value="agent" label={t("nav.dock.agentTab")} icon={Bot} labeled={labeled} />
        ) : null}
      </TabsList>
    </Tabs>
  )
}

function ModeTab({
  value,
  label,
  icon: Icon,
  labeled,
}: {
  value: string
  label: string
  icon: ComponentType
  labeled: boolean
}) {
  return (
    <AppTooltip content={label} side="bottom" delay={150} disabled={labeled}>
      <TabsTrigger
        value={value}
        aria-label={label}
        className={labeled ? "h-6 gap-1 px-1" : "size-6 p-0"}
      >
        <Icon />
        {labeled ? <span>{label}</span> : null}
      </TabsTrigger>
    </AppTooltip>
  )
}
