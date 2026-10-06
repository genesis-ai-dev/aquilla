// Bible data, names through the label chain (AQU-1687; shared since AQU-1689).
//
// One `labelFor(entityId)` per pack and person: the project's agreed names →
// the interface language → English, from where the person's View settings →
// Bible data → Label language says to start. Voices and Who's Who both name
// people with it, so a person reads the same name for Jesus on a voice chip,
// in a mention popover and in the Who's Who panel.

import { useMemo } from "react"
import { projectTargetLaneLanguages } from "@/lib/audio/inworld-voices"
import type { BkpEntity, BkpEntityId } from "@/lib/bible-data/pack-types"
import {
  acaiLanguageFor,
  acaiLanguageForLocale,
  pickLabelText,
  resolveVoiceLabel,
  type VoiceLabel,
  type VoiceLabelOptions,
} from "@/lib/bible-data/voice-labels"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"

export type EntityLabeler = (entityId: BkpEntityId) => VoiceLabel | null

/** The label chain over one pack's entities, cached per entity; null until the entities load. */
export function useEntityLabels(
  project: ProjectRecord,
  entities: Readonly<Record<BkpEntityId, BkpEntity>> | null,
): EntityLabeler | null {
  const { labelMode } = useBibleDataViewPrefs()
  const { locale } = useI18n()
  const multiLane = projectTargetLaneLanguages(project).length > 1
  return useMemo(() => {
    if (!entities) return null
    const options: VoiceLabelOptions = {
      mode: labelMode,
      interfaceLanguage: acaiLanguageForLocale(locale),
      projectNames: {
        concepts: project.terminology ?? [],
        termMatching: project.termMatching,
        sourceLanguage: acaiLanguageFor(project.sourceLanguage),
        multiLane,
      },
    }
    const cache = new Map<BkpEntityId, VoiceLabel | null>()
    return (entityId: BkpEntityId): VoiceLabel | null => {
      const cached = cache.get(entityId)
      if (cached !== undefined) return cached
      const entity = Object.hasOwn(entities, entityId) ? entities[entityId] : undefined
      const label = resolveVoiceLabel(entityId, entity, options)
      cache.set(entityId, label)
      return label
    }
  }, [entities, labelMode, locale, project.terminology, project.termMatching, project.sourceLanguage, multiLane])
}

/** Text picked in the label language, with the BCP 47 tag for its `lang` attribute. */
export interface PickedText {
  text: string
  lang: string
  /** AQU-1700: Traditional characters in a Simplified Chinese interface. */
  otherScript?: true
}

export type LabelTextPicker = (byLanguage: Readonly<Record<string, unknown>> | undefined) => PickedText | null

/** The BCP 47 tag of a pack label key the interface's own tag does not cover: the pack's Chinese keys name their script. */
const LANG_BY_LABEL_KEY: Readonly<Record<string, string>> = { eng: "en", cmn: "zh-Hant", "cmn-Hans": "zh-Hans" }

/**
 * AQU-1695: descriptions, key-term titles and deity forms in the label
 * language (see `pickLabelText`): the interface language, falling back to
 * English, or English only when the person chose it.
 */
export function useLabelText(): LabelTextPicker {
  const { labelMode } = useBibleDataViewPrefs()
  const { locale } = useI18n()
  return useMemo(() => {
    const ui = acaiLanguageForLocale(locale)
    return (byLanguage) => {
      const picked = pickLabelText(byLanguage, labelMode, ui)
      if (!picked) return null
      // Otherwise it picked the interface language itself.
      const lang = Object.hasOwn(LANG_BY_LABEL_KEY, picked.language) ? LANG_BY_LABEL_KEY[picked.language] : locale
      return picked.otherScript ? { text: picked.text, lang, otherScript: true } : { text: picked.text, lang }
    }
  }, [labelMode, locale])
}
