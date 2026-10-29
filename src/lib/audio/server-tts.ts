// One entry point for the engines that synthesize in the sync-worker (hosted
// Inworld and BYOK ElevenLabs, AQU-2299). Both store the clip in R2 and answer
// with the same `SynthesizeCellTtsResult`, so a caller (generate-voice,
// combined-voice) only needs to know the stored clip's extension and type.

import { synthesizeCellTts, type SynthesizeCellTtsResult } from "@/lib/sync/tts"
import { synthesizeElevenLabsTts } from "@/lib/sync/elevenlabs"
import { inworldSynthFieldsFromVoice } from "./inworld-voice-settings"
import { inworldLanguageForRequest } from "./inworld-languages"
import { ElevenLabsError } from "./elevenlabs/errors"
import { elevenLabsLanguageCode, elevenLabsSettingsOf, DEFAULT_ELEVENLABS_MODEL } from "./elevenlabs/settings"
import type { TtsProvider, Voice } from "@/lib/parsers/types"
import type { SyncTokenForFile } from "./upload"

export interface ServerTtsArgs {
  /** An engine for which `isServerTtsProvider` is true. */
  provider: TtsProvider
  /** Already normalized for `provider`. */
  voice: Voice
  projectId: string
  fileId: string
  cellId?: string
  text: string
  /** The lane's language, for engines that take one. */
  targetLanguage?: string
  getSyncToken: SyncTokenForFile
}

export interface ServerTtsResult {
  result: SynthesizeCellTtsResult
  /** Extension of the stored object (`result.objectName`). */
  ext: string
  mimeType: string
}

export async function synthesizeServerTts(args: ServerTtsArgs): Promise<ServerTtsResult> {
  const { voice } = args
  if (args.provider === "elevenlabs") {
    const ref = voice.elevenLabs
    if (!ref?.voiceId) {
      throw new ElevenLabsError("failed", `${voice.name} has no ElevenLabs voice picked — edit the voice and choose one.`)
    }
    const languageCode = elevenLabsLanguageCode(voice.language ?? args.targetLanguage)
    const result = await synthesizeElevenLabsTts({
      projectId: args.projectId,
      fileId: args.fileId,
      ...(args.cellId ? { cellId: args.cellId } : {}),
      text: args.text,
      voiceId: ref.voiceId,
      modelId: ref.modelId ?? DEFAULT_ELEVENLABS_MODEL,
      voiceSettings: elevenLabsSettingsOf(voice),
      ...(languageCode ? { languageCode } : {}),
    }, args.getSyncToken)
    return { result, ext: "mp3", mimeType: "audio/mpeg" }
  }
  const language = inworldLanguageForRequest(voice, args.targetLanguage)
  const result = await synthesizeCellTts(
    {
      projectId: args.projectId,
      fileId: args.fileId,
      ...(args.cellId ? { cellId: args.cellId } : {}),
      text: args.text,
      ...(language ? { language } : {}),
      ...(voice.voiceName ? { voiceId: voice.voiceName } : {}),
      ...inworldSynthFieldsFromVoice(voice),
    },
    args.getSyncToken,
  )
  return { result, ext: "wav", mimeType: "audio/wav" }
}
