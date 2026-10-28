// "Clone voice from take" in one step: copy a line's take into the project's
// reference store and return a clone Voice built on it — the same result as the
// New voice modal's Clone tab with that take picked, minus the modal.

import { audioMimeForExt } from "./mime"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { DEFAULT_TTS_PROVIDER, effectiveTtsProvider, normalizeVoiceForProvider, providerInfo } from "./tts-providers"
import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { buildVoiceReferenceId, uploadVoiceReference } from "./voice-clone"
import { newVoiceId, VOICE_PALETTE } from "./voices"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { TtsProvider, Voice } from "@/lib/parsers/types"

export interface CloneVoiceFromTakeArgs {
  projectId: string
  cell: CellData
  /** The take to copy: the line's recording or generated voice. */
  audioId: string
  name: string
  /** Project engine; a clone falls back to the hosted default when it can't clone. */
  provider?: TtsProvider
  targetLanguage?: string
  /** Picks the new voice's colour (the cast's size, as the modal does). */
  paletteIndex: number
  session: FrontierSession | null
}

/** Which of the cell's selected takes `audioId` is, as the modal keys it. */
function takeKeyFor(cell: CellData, audioId: string): string {
  return `${cell.id}:${audioId === cell.selectedAudioId ? "recorded" : "generated"}`
}

export async function cloneVoiceFromTake(args: CloneVoiceFromTakeArgs): Promise<Voice> {
  const { projectId, cell, audioId, session, targetLanguage } = args
  const url = cell.attachments?.[audioId]?.url
  const parsed = url ? parseFrontierAudioUrl(url) : null
  if (!parsed) throw new Error("This take's audio isn't available to copy.")
  const getSyncToken = audioSyncTokenFetcherForSession(session)
  const bytes = await fetchCellAudio({
    projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: parsed.ext, getSyncToken,
  })
  const blob = new Blob([bytes as BlobPart], { type: audioMimeForExt(parsed.ext) })
  const referenceAudioId = buildVoiceReferenceId(parsed.ext)
  await uploadVoiceReference({ projectId, fileId: cell.fileId, referenceAudioId, blob, getSyncToken })

  const engine = effectiveTtsProvider(args.provider ?? DEFAULT_TTS_PROVIDER)
  const cloneEngine = providerInfo(engine).supportsCloning ? engine : DEFAULT_TTS_PROVIDER
  const draft: Voice = {
    id: newVoiceId(),
    name: args.name.trim(),
    color: VOICE_PALETTE[args.paletteIndex % VOICE_PALETTE.length],
    referenceAudioId,
    referenceTakeKey: takeKeyFor(cell, audioId),
  }
  return normalizeVoiceForProvider(draft, cloneEngine, { targetLanguage })
}
