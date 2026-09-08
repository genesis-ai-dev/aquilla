// One-time persist of legacy OmniVoice TTS settings onto Inworld (AQU-1189).
//
// Runtime still remaps `omnivoice` → `inworld` (`effectiveTtsProvider`) so a
// blocked/offline save cannot strand generate on a leftover stored id. This
// rewrite is what actually clears the stored id: project provider, per-voice
// provider, and language tags stored as ISO-639-3 / display names.

import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import { toInworldLanguageLoose } from "./inworld-languages"
import { normalizeVoiceForProvider } from "./tts-providers"

export function ttsSettingsNeedOmnivoiceMigration(
  settings: ProjectTtsSettings | undefined,
): boolean {
  if (!settings) return false
  if (settings.provider === "omnivoice") return true
  return Boolean(settings.voices?.some((voice) => voice.provider === "omnivoice"))
}

function shouldMigrateVoice(voice: Voice, projectProvider: TtsProvider | undefined): boolean {
  if (voice.provider === "omnivoice") return true
  return projectProvider === "omnivoice" && voice.provider === undefined
}

function migratedLanguage(voice: Voice, targetLanguage?: string): string | undefined {
  const fromVoice = toInworldLanguageLoose(voice.language)
  if (fromVoice) return fromVoice
  if (voice.language?.trim()) return voice.language.trim()
  return toInworldLanguageLoose(targetLanguage)
}

function voiceUnchanged(before: Voice, after: Voice): boolean {
  return (
    before.provider === after.provider
    && before.voiceName === after.voiceName
    && before.language === after.language
    && before.audioQuality === after.audioQuality
    && before.deliveryMode === after.deliveryMode
  )
}

export function migrateOmnivoiceVoice(
  voice: Voice,
  context: { projectProvider?: TtsProvider; targetLanguage?: string } = {},
): Voice {
  if (!shouldMigrateVoice(voice, context.projectProvider)) return voice
  const normalized = normalizeVoiceForProvider(voice, "inworld", {
    targetLanguage: context.targetLanguage,
  })
  const language = migratedLanguage(voice, context.targetLanguage)
  const next: Voice = language ? { ...normalized, language } : { ...normalized }
  return voiceUnchanged(voice, next) ? voice : next
}

/**
 * Returns the same object when nothing needs rewriting so callers can skip
 * persist. Voices on Gemini / Kokoro / MMS are left alone even if the project
 * default was OmniVoice.
 */
export function migrateOmnivoiceTtsSettings(
  settings: ProjectTtsSettings | undefined,
  context: { targetLanguage?: string } = {},
): ProjectTtsSettings | undefined {
  if (!settings) return settings
  const projectProvider = settings.provider
  let changed = projectProvider === "omnivoice"
  const nextProvider: TtsProvider | undefined = changed ? "inworld" : projectProvider

  let nextVoices = settings.voices
  if (settings.voices?.length) {
    const mapped = settings.voices.map((voice) => {
      const next = migrateOmnivoiceVoice(voice, {
        projectProvider,
        targetLanguage: context.targetLanguage,
      })
      if (next !== voice) changed = true
      return next
    })
    if (changed) nextVoices = mapped
  }

  if (!changed) return settings
  return {
    ...settings,
    ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    ...(nextVoices !== settings.voices ? { voices: nextVoices } : {}),
  }
}

export interface OmnivoiceMigrationProperties {
  project_provider_migrated: boolean
  voice_count: number
  cloned_voice_count: number
  from_languages: string[]
  to_languages: string[]
}

function uniqueLanguages(voices: Voice[]): string[] {
  const seen = new Set<string>()
  for (const voice of voices) {
    const tag = voice.language?.trim()
    if (tag) seen.add(tag)
  }
  return [...seen]
}

/** Counts and language tags for the PostHog event fired when we persist. */
export function omnivoiceMigrationProperties(
  before: ProjectTtsSettings | undefined,
  context: { targetLanguage?: string } = {},
): OmnivoiceMigrationProperties {
  const projectProvider = before?.provider
  const migrated = (before?.voices ?? []).filter((voice) =>
    shouldMigrateVoice(voice, projectProvider),
  )
  const after = migrated.map((voice) =>
    migrateOmnivoiceVoice(voice, { projectProvider, targetLanguage: context.targetLanguage }),
  )
  return {
    project_provider_migrated: projectProvider === "omnivoice",
    voice_count: migrated.length,
    cloned_voice_count: migrated.filter((voice) => Boolean(voice.referenceAudioId)).length,
    from_languages: uniqueLanguages(migrated),
    to_languages: uniqueLanguages(after),
  }
}
