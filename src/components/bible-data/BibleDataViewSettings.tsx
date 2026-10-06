// View settings → Bible data (AQU-1687, AQU-1689): each person's options for
// what the Voices and Who's Who enrichments show them. Device-local
// (src/lib/store/bible-data-view-prefs.ts); the project decides whether each
// enrichment exists at all, and only its options are listed. AQU-1692: it
// also says when the open book's Bible data did not load, and lists the
// project's voice corrections that a rebuilt pack left without a speech.

import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import type { BkpFailureReason } from "@/lib/bible-data/pack-client"
import { refOfWord } from "@/lib/bible-data/versification"
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
import type { BibleVoiceOverrides } from "../../../db/shared/bible-voice-overrides"
import type { BiblePackStatus } from "./bible-data-bus"

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

const PACK_FAILURE_KEYS: Readonly<Record<BkpFailureReason, MessageKey>> = {
  offline: "bibleVoices.pack.offline",
  "not-found": "bibleVoices.pack.notFound",
  invalid: "bibleVoices.pack.invalid",
}

interface BibleDataViewSettingsProps {
  /** The project has Voices on: voice chips and speech rails apply. */
  voices: boolean
  /** The project has Who's Who on: highlights and implied-subject hints apply. */
  whosWho: boolean
  /** AQU-1692: how the open book's Bible data loaded, as the editor published it. */
  status?: BiblePackStatus | null
  /** AQU-1692: the project's voice corrections, to describe the orphaned ones. */
  corrections?: BibleVoiceOverrides
  /** AQU-1692: a maintainer removes an orphaned correction. */
  onRemoveCorrection?: (speechId: string) => void
}

export function BibleDataViewSettings({
  voices,
  whosWho,
  status,
  corrections,
  onRemoveCorrection,
}: BibleDataViewSettingsProps) {
  const t = useT()
  const prefs = useBibleDataViewPrefs()
  const orphaned = (status?.orphanedCorrections ?? []).flatMap((speechId) => {
    const entry = corrections?.[speechId]
    return entry ? [{ speechId, entry }] : []
  })
  return (
    <div data-testid="bible-data-view-settings" className="flex flex-col gap-2">
      {/* The same name as the project's Bible data card, which is titled
          "Bible data" while the experiment is on (AQU-1685), as it is
          whenever this section shows. */}
      <div className="text-xs font-medium text-muted-foreground">{t("bibleData.card.title")}</div>
      {/* AQU-1692: say why nothing shows, rather than leave the person guessing. */}
      {status?.failure && (
        <p data-testid="bible-data-pack-status" className="text-xs text-muted-foreground">
          {t(PACK_FAILURE_KEYS[status.failure])}
        </p>
      )}
      {status && orphaned.length > 0 && (
        <div data-testid="bible-data-orphaned-corrections" className="flex flex-col gap-1 text-xs">
          <p className="text-muted-foreground">{t("bibleVoices.orphaned.heading", { count: orphaned.length })}</p>
          <ul className="flex flex-col gap-1">
            {orphaned.map(({ speechId, entry }) => (
              <li key={speechId} className="flex items-baseline gap-1">
                <span className="min-w-0 flex-1">
                  <bdi>{refOfWord(status.book, speechId.slice(3).split("-")[0]) ?? speechId}</bdi>
                  {" · "}
                  <bdi>{entry.by}</bdi>
                  {": "}
                  <span dir="auto">{entry.note}</span>
                </span>
                {onRemoveCorrection && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto shrink-0 px-0 py-0 text-xs"
                    onClick={() => onRemoveCorrection(speechId)}
                  >
                    {t("bibleVoices.orphaned.remove")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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
