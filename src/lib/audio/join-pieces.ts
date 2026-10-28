// AQU-981: "Join into one recording" — a take in pieces becomes one new take
// of those pieces, in order. The pieces stay in the take list; the joined
// take is the one that plays (an ordinary attach selects it, exactly as
// recording a new take does).
//
// Two paths, one outcome:
//   - The pieces tile their recording end to end (a recording uploaded in parts
//     and cut at the joins, or a take cut and never trimmed): the joined
//     version IS that recording, so the new take is the same bytes under its
//     own id — nothing is decoded or uploaded.
//   - Otherwise (pieces trimmed, or from different recordings): each piece's
//     audible part is decoded, the parts are joined, and the result is
//     uploaded as a WAV.

import type { FrontierSession } from "@/lib/frontier/types"
import { buildAudioId, fetchCellAudio, parseFrontierAudioUrl, uploadCellAudio } from "@/lib/audio/upload"
import { audioCacheGet } from "@/lib/audio/bytes-cache"
import { attachUploadedTake, OFFLINE_MESSAGE } from "@/lib/audio/attach-file"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"

export interface JoinPiece {
  audioId: string
  url: string
  trimStartMs?: number | null
  trimEndMs?: number | null
  durationMs?: number | null
  mimeType?: string | null
}

/** Within this many ms, two edges are the same place (rounding at the cut). */
const EDGE_MS = 2

/**
 * When the pieces cover their one recording from its start to its end with
 * nothing left out, the joined take is that recording: its url. Null otherwise.
 */
export function wholeRecordingOf(pieces: readonly JoinPiece[]): string | null {
  if (pieces.length === 0) return null
  const url = pieces[0].url
  if (pieces.some((p) => p.url !== url)) return null
  const ordered = [...pieces].sort((a, b) => (a.trimStartMs ?? 0) - (b.trimStartMs ?? 0))
  if ((ordered[0].trimStartMs ?? 0) > EDGE_MS) return null
  for (let i = 0; i < ordered.length - 1; i++) {
    const end = ordered[i].trimEndMs
    const nextStart = ordered[i + 1].trimStartMs ?? 0
    if (end == null || Math.abs(end - nextStart) > EDGE_MS) return null
  }
  const last = ordered[ordered.length - 1]
  const duration = last.durationMs ?? null
  if (last.trimEndMs != null && (duration == null || Math.abs(last.trimEndMs - duration) > EDGE_MS)) return null
  return url
}

export interface JoinPiecesArgs {
  session: FrontierSession | null
  projectId: string
  fileId: string
  cellId: string
  /** Every live piece of the take, in clip order. */
  pieces: readonly JoinPiece[]
  slot: string
  targetLang?: string
  username: string
}

async function bytesOf(url: string, args: JoinPiecesArgs, getSyncToken: ReturnType<typeof audioSyncTokenFetcherForSession>): Promise<Uint8Array> {
  const parsed = parseFrontierAudioUrl(url)
  if (!parsed) throw new Error("this piece's audio can't be read")
  const cached = await audioCacheGet(parsed.audioId, parsed.ext)
  if (cached) return cached
  return fetchCellAudio({ projectId: args.projectId, fileId: args.fileId, audioId: parsed.audioId, ext: parsed.ext, getSyncToken })
}

/** Join the pieces into one new take. Returns the new take's id. */
export async function joinTakePieces(args: JoinPiecesArgs): Promise<string> {
  if (!navigator.onLine) throw new Error(OFFLINE_MESSAGE)
  if (!args.session?.jwt) throw new Error("Sign in to join recordings")
  if (args.pieces.length < 2) throw new Error("there is nothing to join")
  const getSyncToken = audioSyncTokenFetcherForSession(args.session)
  const common = {
    projectId: args.projectId,
    fileId: args.fileId,
    cellId: args.cellId,
    slot: args.slot,
    username: args.username,
    surface: "recording-tab" as const,
    ...(args.targetLang ? { targetLang: args.targetLang } : {}),
  }

  const whole = wholeRecordingOf(args.pieces)
  if (whole) {
    const parsed = parseFrontierAudioUrl(whole)
    const ext = parsed?.ext ?? "wav"
    const audioId = `${buildAudioId(args.cellId)}.${ext}`
    const last = [...args.pieces].sort((a, b) => (b.trimEndMs ?? Infinity) - (a.trimEndMs ?? Infinity))[0]
    await attachUploadedTake({
      ...common,
      audioId,
      url: whole,
      mimeType: args.pieces[0].mimeType ?? undefined,
      durationMs: last.durationMs ?? last.trimEndMs ?? undefined,
    })
    notifyAudioAttachmentsChanged(args.fileId)
    return audioId
  }

  const { decodeToMono48k, concatPcm, TARGET_RATE } = await import("@/lib/audio/decode-mono")
  const { encodeWavPcm16 } = await import("@/lib/audio/wav-encode")
  const decoded = new Map<string, Float32Array>()
  const parts: Float32Array[] = []
  for (const piece of args.pieces) {
    let pcm = decoded.get(piece.url)
    if (!pcm) {
      pcm = await decodeToMono48k(await bytesOf(piece.url, args, getSyncToken))
      decoded.set(piece.url, pcm)
    }
    const from = Math.max(0, Math.round(((piece.trimStartMs ?? 0) / 1000) * TARGET_RATE))
    const to = piece.trimEndMs != null ? Math.min(pcm.length, Math.round((piece.trimEndMs / 1000) * TARGET_RATE)) : pcm.length
    if (to > from) parts.push(pcm.subarray(from, to))
  }
  const joined = concatPcm(parts)
  const blob = encodeWavPcm16(joined, TARGET_RATE)
  const result = await uploadCellAudio({ projectId: args.projectId, fileId: args.fileId, audioId: buildAudioId(args.cellId), ext: "wav", blob, getSyncToken })
  const audioId = `${result.audioId}.${result.ext}`
  await attachUploadedTake({
    ...common,
    audioId,
    url: result.url,
    mimeType: "audio/wav",
    durationMs: Math.round((joined.length / TARGET_RATE) * 1000),
  })
  notifyAudioAttachmentsChanged(args.fileId)
  return audioId
}
