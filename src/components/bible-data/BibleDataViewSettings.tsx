// View settings → Bible data (AQU-1687, AQU-1689): each person's options for
// what the Voices and Who's Who enrichments show them. Device-local
// (src/lib/store/bible-data-view-prefs.ts); the project decides whether each
// enrichment exists at all, and only its options are listed.

import { Field, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { isVoiceLabelMode, type VoiceLabelMode } from "@/lib/bible-data/voice-labels"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  isImpliedSubjectHintMode,
  isWhosWhoHighlightMode,
  setBibleDataViewPrefs,
  useBibleDataViewPrefs,
  type ImpliedSubjectHintMode,
  type WhosWhoHighlightMode,
} from "@/lib/store/bible-data-view-prefs"

const LABEL_MODE_OPTIONS: readonly { value: VoiceLabelMode; labelKey: MessageKey }[] = [
  { value: "project", labelKey: "bibleData.view.labelLanguage.project" },
  { value: "interface", labelKey: "bibleData.view.labelLanguage.interface" },
  { value: "english", labelKey: "bibleData.view.labelLanguage.english" },
]

const HIGHLIGHT_OPTIONS: readonly { value: WhosWhoHighlightMode; labelKey: MessageKey }[] = [
  { value: "hover", labelKey: "bibleData.view.whosWhoHighlights.hover" },
  { value: "always", labelKey: "bibleData.view.whosWhoHighlights.always" },
  { value: "off", labelKey: "bibleData.view.off" },
]

const HINT_OPTIONS: readonly { value: ImpliedSubjectHintMode; labelKey: MessageKey }[] = [
  { value: "off", labelKey: "bibleData.view.off" },
  { value: "names", labelKey: "bibleData.view.impliedSubjectHints.names" },
  { value: "all", labelKey: "bibleData.view.impliedSubjectHints.all" },
]

interface BibleDataViewSettingsProps {
  /** The project has Voices on: voice chips and speech rails apply. */
  voices: boolean
  /** The project has Who's Who on: highlights and implied-subject hints apply. */
  whosWho: boolean
}

export function BibleDataViewSettings({ voices, whosWho }: BibleDataViewSettingsProps) {
  const t = useT()
  const prefs = useBibleDataViewPrefs()
  return (
    <div data-testid="bible-data-view-settings" className="flex flex-col gap-2">
      {/* The same name as the project's Bible data card. */}
      <div className="text-xs font-medium text-muted-foreground">{t("projectSettings.section.bibleResources")}</div>
      {voices && (
        <>
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
        </>
      )}
      {whosWho && (
        <>
          <ChoiceGroup
            idPrefix="bible-whos-who-highlights"
            labelKey="bibleData.view.whosWhoHighlights"
            value={prefs.whosWhoHighlights}
            options={HIGHLIGHT_OPTIONS}
            onChange={(value) => {
              if (isWhosWhoHighlightMode(value)) setBibleDataViewPrefs({ whosWhoHighlights: value })
            }}
          />
          <ChoiceGroup
            idPrefix="bible-implied-hints"
            labelKey="bibleData.view.impliedSubjectHints"
            value={prefs.impliedSubjectHints}
            options={HINT_OPTIONS}
            onChange={(value) => {
              if (isImpliedSubjectHintMode(value)) setBibleDataViewPrefs({ impliedSubjectHints: value })
            }}
          />
        </>
      )}
      <ChoiceGroup
        idPrefix="bible-label-mode"
        labelKey="bibleData.view.labelLanguage"
        value={prefs.labelMode}
        options={LABEL_MODE_OPTIONS}
        onChange={(value) => {
          if (isVoiceLabelMode(value)) setBibleDataViewPrefs({ labelMode: value })
        }}
      />
    </div>
  )
}

function ChoiceGroup<T extends string>({
  idPrefix,
  labelKey,
  value,
  options,
  onChange,
}: {
  idPrefix: string
  labelKey: MessageKey
  value: T
  options: readonly { value: T; labelKey: MessageKey }[]
  onChange: (value: unknown) => void
}) {
  const t = useT()
  return (
    <>
      <div className="text-xs text-muted-foreground">{t(labelKey)}</div>
      <RadioGroup value={value} onValueChange={onChange} aria-label={t(labelKey)} className="gap-2">
        {options.map((option) => {
          const id = `${idPrefix}-${option.value}`
          return (
            <div key={option.value} className="flex items-center gap-3">
              <RadioGroupItem id={id} value={option.value} />
              <Label htmlFor={id} layout="inline" className="font-normal">
                {t(option.labelKey)}
              </Label>
            </div>
          )
        })}
      </RadioGroup>
    </>
  )
}
