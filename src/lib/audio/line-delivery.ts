// How one line is delivered (AQU-2577): its own speed and expressiveness over
// its voice's settings, and the audio tags it is spoken with.
//
// A voice's settings are right for most of its lines; the line that should be
// slower, or said through tears, had no way to be different except by editing
// the voice for every line. A line's delivery is stored beside the cast, in
// `ProjectTtsSettings.lineDelivery`, and applied in the one place speech is
// generated (generate-voice.ts), so every way of generating a line reads it.
//
// Tags are ElevenLabs audio tags ("[whispers]"). They go in front of the text
// sent to the engine and nowhere else: the translation and its exports never
// see them. Only models that read tags get them (settings.ts) — another model
// would say the word aloud.

import { DEFAULT_ELEVENLABS_MODEL, elevenLabsModelReadsTags, isElevenLabsVoice } from "./elevenlabs/settings"
import type { ElevenLabsVoiceSettings, LineDelivery, ProjectTtsSettings, Voice } from "@/lib/parsers/types"

/** Tags offered as chips. ElevenLabs documents these as examples; any word in brackets is accepted. */
export const SUGGESTED_LINE_TAGS: readonly string[] = ["whispers", "sighs", "crying", "excited", "curious", "laughs"]

export const MAX_LINE_TAGS = 6

/** A tag as stored: lower case, no brackets, letters digits and spaces only. Empty when nothing is left. */
export function normalizeLineTag(raw: string): string {
  return raw.replace(/[[\]]/g, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40)
}

export function lineDeliveryFor(settings: ProjectTtsSettings | undefined, cellId: string): LineDelivery | undefined {
  return settings?.lineDelivery?.[cellId]
}

function isEmpty(delivery: LineDelivery): boolean {
  return !delivery.tags?.length && Object.keys(delivery.settings ?? {}).length === 0
}

/** The `lineDelivery` patch that sets (or, when nothing is left in it, clears) one line's delivery. */
export function lineDeliveryPatch(
  settings: ProjectTtsSettings | undefined,
  cellId: string,
  delivery: LineDelivery | null,
): Pick<ProjectTtsSettings, "lineDelivery"> {
  const next = { ...(settings?.lineDelivery ?? {}) }
  if (!delivery || isEmpty(delivery)) delete next[cellId]
  else next[cellId] = delivery
  return { lineDelivery: next }
}

/** Whether a line's delivery can be set at all: its voice must be an ElevenLabs one. */
export function voiceTakesLineDelivery(voice: Pick<Voice, "provider" | "elevenLabs">): boolean {
  return isElevenLabsVoice(voice)
}

export interface SpokenLine {
  voice: Voice
  text: string
}

/**
 * The voice and text actually sent to the engine for a line: the voice with the
 * line's own settings laid over its own, and the text with the line's tags in
 * front. Both come back unchanged for a line with no delivery, or a voice that
 * is not an ElevenLabs one.
 */
export function withLineDelivery(voice: Voice, text: string, delivery: LineDelivery | undefined): SpokenLine {
  if (!delivery || !voice.elevenLabs || !isElevenLabsVoice(voice)) return { voice, text }
  const settings = delivery.settings && Object.keys(delivery.settings).length > 0
    ? { ...(voice.elevenLabs.settings ?? {}), ...delivery.settings } as ElevenLabsVoiceSettings
    : voice.elevenLabs.settings
  const tags = (delivery.tags ?? []).map(normalizeLineTag).filter(Boolean).slice(0, MAX_LINE_TAGS)
  const readsTags = elevenLabsModelReadsTags(voice.elevenLabs.modelId ?? DEFAULT_ELEVENLABS_MODEL)
  return {
    voice: settings === voice.elevenLabs.settings ? voice : { ...voice, elevenLabs: { ...voice.elevenLabs, settings } },
    text: readsTags && tags.length > 0 ? `${tags.map((tag) => `[${tag}]`).join(" ")} ${text}` : text,
  }
}
