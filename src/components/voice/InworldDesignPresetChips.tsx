import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  INWORLD_DESIGN_PRESET_IDS,
  inworldDesignPresetPrompt,
  matchingInworldDesignPreset,
  type InworldDesignMode,
  type InworldDesignPresetId,
} from "@/lib/audio/inworld-voice-design"

const PRESET_LABEL_KEY = {
  agent: "audio.newVoice.designPresetAgent",
  narrator: "audio.newVoice.designPresetNarrator",
  companion: "audio.newVoice.designPresetCompanion",
  instructor: "audio.newVoice.designPresetInstructor",
  pirate: "audio.newVoice.designPresetPirate",
} as const satisfies Record<InworldDesignPresetId, MessageKey>

export function InworldDesignPresetChips({
  mode,
  value,
  onSelect,
}: {
  mode: InworldDesignMode
  value: string
  onSelect: (text: string) => void
}) {
  const t = useT()
  const selected = matchingInworldDesignPreset(value, mode)

  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="group"
      aria-label={t("audio.newVoice.designPresetGroupLabel")}
    >
      {INWORLD_DESIGN_PRESET_IDS.map((id) => (
        <Button
          key={id}
          type="button"
          variant="outline"
          size="xs"
          aria-pressed={selected === id}
          onClick={() => onSelect(inworldDesignPresetPrompt(id, mode))}
        >
          {t(PRESET_LABEL_KEY[id])}
        </Button>
      ))}
    </div>
  )
}
