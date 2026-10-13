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
