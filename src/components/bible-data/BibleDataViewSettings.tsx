// View settings → Bible data (AQU-1687): each person's options for what the
// Voices enrichment shows them. Device-local (src/lib/store/bible-data-view-prefs.ts);
// the project decides whether Voices exists at all.

import { Field, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { isVoiceLabelMode, type VoiceLabelMode } from "@/lib/bible-data/voice-labels"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { setBibleDataViewPrefs, useBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"

const LABEL_MODE_OPTIONS: readonly { value: VoiceLabelMode; labelKey: MessageKey }[] = [
  { value: "project", labelKey: "bibleData.view.labelLanguage.project" },
  { value: "interface", labelKey: "bibleData.view.labelLanguage.interface" },
  { value: "english", labelKey: "bibleData.view.labelLanguage.english" },
]

export function BibleDataViewSettings() {
  const t = useT()
  const prefs = useBibleDataViewPrefs()
  return (
    <div data-testid="bible-data-view-settings" className="flex flex-col gap-2">
      {/* The same name as the project's Bible data card, which is titled
          "Bible data" while the experiment is on (AQU-1685), as it is
          whenever this section shows. */}
      <div className="text-xs font-medium text-muted-foreground">{t("bibleData.card.title")}</div>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="view-bible-voice-chips" className="font-normal">
          {t("bibleData.view.voiceChips")}
        </FieldLabel>
        <Switch
          id="view-bible-voice-chips"
          checked={prefs.voiceChips}
          onCheckedChange={(next) => setBibleDataViewPrefs({ voiceChips: next })}
          aria-label={t("bibleData.view.voiceChips")}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="view-bible-speech-rails" className="font-normal">
          {t("bibleData.view.speechRails")}
        </FieldLabel>
        <Switch
          id="view-bible-speech-rails"
          checked={prefs.speechRails}
          onCheckedChange={(next) => setBibleDataViewPrefs({ speechRails: next })}
          aria-label={t("bibleData.view.speechRails")}
        />
      </Field>
      <div className="text-xs text-muted-foreground">{t("bibleData.view.labelLanguage")}</div>
      <RadioGroup
        value={prefs.labelMode}
        onValueChange={(value) => {
          if (isVoiceLabelMode(value)) setBibleDataViewPrefs({ labelMode: value })
        }}
        aria-label={t("bibleData.view.labelLanguage")}
        className="gap-2"
      >
        {LABEL_MODE_OPTIONS.map(({ value, labelKey }) => {
          const id = `bible-label-mode-${value}`
          return (
            <div key={value} className="flex items-center gap-3">
              <RadioGroupItem id={id} value={value} />
              <Label htmlFor={id} layout="inline" className="font-normal">
                {t(labelKey)}
              </Label>
            </div>
          )
        })}
      </RadioGroup>
    </div>
  )
}
