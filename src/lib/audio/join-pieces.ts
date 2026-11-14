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
import type { CellData } from "@/hooks/useCells"
import { buildAudioId, fetchCellAudio, parseFrontierAudioUrl, uploadCellAudio } from "@/lib/audio/upload"
import { audioCacheGet } from "@/lib/audio/bytes-cache"
import { attachUploadedTake, OFFLINE_MESSAGE } from "@/lib/audio/attach-file"
import { keptTakePlace, type TakePlace } from "@/lib/audio/new-take-place"
import { targetChipGeom, targetOffsetMsFor } from "@/lib/timeline/lane-timing"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { recordTakeAdded } from "@/lib/history/take-steps"

export interface JoinPiece {
  audioId: string
  url: string
  trimStartMs?: number | null
  trimEndMs?: number | null
  durationMs?: number | null
  mimeType?: string | null
  /** AQU-2491 (review, Nov 9): its own places, which the joined take keeps. */
  targetOffsetMs?: number | null
  recordingsOffsetMs?: number | null
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

/**
 * AQU-2491 (merge review, Nov 13): WHERE THE JOINED TAKE SITS. One rule: its
 * clip starts where its first piece's SOUND started, in each timing.
 *
 * The decoded join leaves the first piece's head trim out (`droppedHeadMs`;
 * the whole recording keeps it, and drops nothing). So: take what the piece
 * reads in each timing now, and move each place that marks a clip's start by
 * the head the join dropped. Two facts about what is stored decide which:
 *   1. A place following the source, and a layer's place following the
 *      recordings, mark the clip's start. A main or voice take's place
 *      following the recordings marks its sound (a head trim tightens the
 *      line there), so it stays.
 *   2. A take with no place of its own reads the next one down: following the
 *      source, its line's (on a line with no times, its slot's start);
 *      following the recordings, its place following the source (on the main
 *      track or a voice track, as its line's start when it is before it).
 * The new clip has no head left to hide, so it never starts before 0:00
 * (`targetOffsetMsFor`; AQU-2495). Dropping nothing keeps the piece's places
 * as they are: no place stays no place.
 */
export function joinedTakePlace(
  line: CellData,
  first: JoinPiece,
  droppedHeadMs: number,
  onLayer: boolean,
): TakePlace | null {
  const dropMs = Math.max(0, Math.round(droppedHeadMs))
  if (dropMs === 0) return keptTakePlace(first)
  const timed = typeof line.startTime === "number" && Number.isFinite(line.startTime)
  const lineStartSec = timed ? line.startTime! : 0
  // What the piece reads now, following the source…
  const lineGeom = first.targetOffsetMs == null && timed ? targetChipGeom(line, undefined) : null
  const sourceMs = first.targetOffsetMs ?? (lineGeom ? Math.round((lineGeom.anchor - lineStartSec) * 1000) : 0)
  // …and following the recordings.
  const recordingsMs = first.recordingsOffsetMs ?? (onLayer ? sourceMs : Math.max(0, sourceMs))
  return {
    targetOffsetMs: targetOffsetMsFor(line, lineStartSec + (sourceMs + dropMs) / 1000),
    recordingsOffsetMs: onLayer ? recordingsMs + dropMs : recordingsMs,
  }
}

export interface JoinPiecesArgs {
  session: FrontierSession | null
  projectId: string
  fileId: string
  cellId: string
  /** Every live piece of the take, in clip order. */
  pieces: readonly JoinPiece[]
  /** The line the take is on (the cell holding it), which the joined take is
   *  placed against (`joinedTakePlace`). */
  line: CellData
  /** The take is on a track made a layer (music, effects): following the
   *  recordings its clip is placed as following the source. */
  onLayer: boolean
  slot: string
  targetLang?: string
  username: string
  /** The new take's name. Sam, Oct 29: "Take N", the way the recorder names a
   *  new take — the caller works it out with `nextTakeLabel` over the line's
   *  takes on this track. */
  label?: string
  /** AQU-2492 (review, Nov 9): record an Undo step for the joined take,
   *  naming the take that played in its slot before (the take in pieces). */
  history?: { selectedBefore: string | null }
}

/**
 * The joined take is an added take: Undo takes it away and plays the pieces
 * again. AQU-2492 (review, Nov 9), finding 15: recorded as the join STARTS,
 * waiting on it (`landed`), so ⌘Z pressed while it decodes and uploads waits
 * for it and undoes the join, never an older step. A failed join drops it.
 */
function recordJoined(args: JoinPiecesArgs, audioId: string): (ok: boolean) => void {
  if (!args.history) return () => {}
  let landed: (ok: boolean) => void = () => {}
  const pending = new Promise<boolean>((resolve) => { landed = resolve })
  recordTakeAdded(
    "join",
    { cellId: args.cellId, audioId, slot: args.slot, selectedBefore: args.history.selectedBefore },
    { fileId: args.fileId },
    { pending },
  )
  return landed
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
    label: args.label,
    surface: "recording-tab" as const,
    ...(args.targetLang ? { targetLang: args.targetLang } : {}),
  }

  const whole = wholeRecordingOf(args.pieces)
  // AQU-2491 (review, Nov 9): made from the pieces, it is placed by their place
  // (the first piece's) rather than reading one an older recording left on the
  // line. Merge review, Nov 13: where that piece's SOUND was — the decoded
  // join leaves its head trim out, the whole recording keeps it.
  const place = joinedTakePlace(args.line, args.pieces[0], whole ? 0 : (args.pieces[0].trimStartMs ?? 0), args.onLayer)
  // AQU-2492 (review, Nov 9), finding 15: the joined take's id, minted before
  // any work, so its Undo step can be recorded as the join starts.
  const baseId = buildAudioId(args.cellId)
  const ext = whole ? (parseFrontierAudioUrl(whole)?.ext ?? "wav") : "wav"
  const audioId = `${baseId}.${ext}`
  const landed = recordJoined(args, audioId)
  try {
    await joinAs(args, getSyncToken, { ...common, place }, whole, baseId, audioId)
  } catch (e) {
    landed(false)
    throw e
  }
  notifyAudioAttachmentsChanged(args.fileId)
  landed(true)
  return audioId
}

async function joinAs(
  args: JoinPiecesArgs,
  getSyncToken: ReturnType<typeof audioSyncTokenFetcherForSession>,
  common: Omit<Parameters<typeof attachUploadedTake>[0], "audioId" | "url" | "mimeType" | "durationMs">,
  whole: string | null,
  baseId: string,
  audioId: string,
): Promise<void> {
  if (whole) {
    const last = [...args.pieces].sort((a, b) => (b.trimEndMs ?? Infinity) - (a.trimEndMs ?? Infinity))[0]
    await attachUploadedTake({
      ...common,
      audioId,
      url: whole,
      mimeType: args.pieces[0].mimeType ?? undefined,
      durationMs: last.durationMs ?? last.trimEndMs ?? undefined,
    })
    return
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
  const result = await uploadCellAudio({ projectId: args.projectId, fileId: args.fileId, audioId: baseId, ext: "wav", blob, getSyncToken })
  await attachUploadedTake({
    ...common,
    // The id the step names: the upload stores the bytes under it.
    audioId,
    url: result.url,
    mimeType: "audio/wav",
    durationMs: Math.round((joined.length / TARGET_RATE) * 1000),
  })
}
