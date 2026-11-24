// Whether a voice can speak this lane's lines right now (AQU-2742). A voice
// that cannot is not offered in Make speech: picking it would only spend a run
// to learn what was already known here.
import type { ProjectTtsSettings, TtsProvider, Voice } from "@/lib/parsers/types"
import type { CustomVoiceState } from "./custom-voice"
import { isCustomVoice } from "./custom-voice"
import { isElevenLabsVoice } from "./elevenlabs/settings"
import { toInworldLanguage } from "./inworld-languages"
import { effectiveTtsProvider } from "./tts-providers"

export type VoiceBlocker =
  /** An ElevenLabs voice, and this user has not connected an ElevenLabs key on this device. */
  | { kind: "elevenlabs-key" }
  /** A Gemini voice, and the project has no Gemini key on this device. */
  | { kind: "gemini-key" }
  /** A custom voice that is still training, or whose training failed. */
  | { kind: "training" }
  | { kind: "training-failed" }
  /** An Inworld stock voice picked for another language than this lane's. */
  | { kind: "language"; language: string }

export interface VoiceUsableContext {
  /** The project's engine, used when a voice names none. */
  projectProvider?: TtsProvider
  hasElevenLabsKey: boolean
  hasGeminiKey: boolean
  /** The lane's language tag. */
  laneLanguage?: string
  /** Training state of a custom voice; null or absent while it is not known yet. */
  customState?: (voice: Voice) => CustomVoiceState | null | undefined
}

function primary(tag: string | undefined): string | undefined {
  return toInworldLanguage(tag)?.split("-")[0]?.toLowerCase()
}

export function voiceBlocker(voice: Voice, ctx: VoiceUsableContext): VoiceBlocker | null {
  if (isCustomVoice(voice)) {
    // Unknown is not a reason: the first status answer can take a moment.
    const state = ctx.customState?.(voice)
    if (state === "queued" || state === "training") return { kind: "training" }
    if (state === "failed") return { kind: "training-failed" }
  }
  if (isElevenLabsVoice(voice)) return ctx.hasElevenLabsKey ? null : { kind: "elevenlabs-key" }
  const provider = effectiveTtsProvider(voice.provider ?? ctx.projectProvider)
  if (provider === "gemini" && !ctx.hasGeminiKey) return { kind: "gemini-key" }
  if (provider === "inworld" && voice.language) {
    const lane = primary(ctx.laneLanguage)
    const own = primary(voice.language)
    // A lane Inworld can't map speaks in the voice's own language by design.
    if (lane && own && lane !== own) return { kind: "language", language: voice.language }
  }
  return null
}

/** The parts of the TTS settings the check reads. */
export function voiceUsableContext(
  settings: Pick<ProjectTtsSettings, "provider" | "apiKey"> | undefined,
  extra: Omit<VoiceUsableContext, "projectProvider" | "hasGeminiKey">,
): VoiceUsableContext {
  return { ...extra, projectProvider: settings?.provider, hasGeminiKey: Boolean(settings?.apiKey?.trim()) }
}
