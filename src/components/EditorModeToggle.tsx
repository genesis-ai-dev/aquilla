// Text / Media / Transcribe / Agent switch in the chapter navigation row.
// Compact viewports stay icon-only with a tooltip; md+ (768px, same as the
// Check file control in this row) shows the label beside the icon.
// Text and Media read the SAME cell list over one mounted table; Media stacks
// the timeline over it, and the workspace TRACES the current cell across the
// switch (AQU-646 — media→text scrolls+flashes the row, text→media selects/
// centers/cues the clip). AQU-1758: one label, "Media", on every file — the
// Audio view a book used to open in here is gone. The stored lens value for
// Media stays "audio", so every project's saved choice keeps working.

import { useSyncExternalStore, type ComponentType } from "react"
import { Pencil, AudioWaveform, Bot, Captions } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

/** "transcribe": the two-step transcription view (ASR, then AI cleanup). */
export type EditorLens = "text" | "audio" | "transcribe"

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
  /** "active": only the open view keeps its label; the others are icons with
   *  their names on hover (the media view's top bar, canvas board 55). */
  labels?: "all" | "active"
  /** Open the full Agent workbench. Agent is a destination rather than a
   * persisted editor lens, so selecting it delegates navigation to the shell. */
  onAgentSelect?: () => void
  /** When the Agent workbench is showing, select the Agent tab so Text/Media
   *  remain one click away. */
  agentActive?: boolean
}

export function EditorModeToggle({
  lens,
  onChange,
  onAgentSelect,
  agentActive = false,
  labels = "all",
}: Props) {
  const t = useT()
  const wide = useIsMdUp()
  const current = agentActive ? "agent" : lens
  const labeledFor = (value: string) => wide && (labels === "all" || value === current)
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
        <ModeTab value="text" label={t("editor.lens.text")} icon={Pencil} labeled={labeledFor("text")} />
        <ModeTab value="audio" label={t("nav.lens.media")} icon={AudioWaveform} labeled={labeledFor("audio")} />
        <ModeTab value="transcribe" label={t("nav.lens.transcribe")} icon={Captions} labeled={labeledFor("transcribe")} />
        {(onAgentSelect || agentActive) ? (
          <ModeTab value="agent" label={t("nav.dock.agentTab")} icon={Bot} labeled={labeledFor("agent")} />
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
        className={labeled ? undefined : "size-6 p-0"}
      >
        <Icon />
        {labeled ? <span>{label}</span> : null}
      </TabsTrigger>
    </AppTooltip>
  )
}
