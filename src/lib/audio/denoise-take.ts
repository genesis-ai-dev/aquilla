// Orchestrates "remove noise from a take": fetch the source clip, run RNNoise
// on-device, and attach the cleaned result as a NEW take (auto-selected). The
// original is never mutated — it stays in the takes strip. The cleaned take
// records its source via `referenceAudioId`, which the UI uses to revert.
//
// Mirrors the recording-modal save flow (upload → cell.audio.attach → optimistic
// inject + bus poke) so the cleaned take surfaces immediately, even if the WS is
// momentarily down.

import type { FrontierSession } from "@/lib/frontier/types"
import {
  buildDenoisedAudioId,
  uploadCellAudio,
  deleteCellAudio,
  fetchCellAudio,
  parseFrontierAudioUrl,
} from "./upload"
import { audioCachePutBlob } from "./bytes-cache"
import { decodeToMono48k, TARGET_RATE } from "./decode-mono"
import { loudnessClient } from "./loudness-client"
import { denoiseMono48k } from "./denoise"
import { emitCellAudioAttach, emitCellAudioGain, emitCellAudioPlace, emitCellAudioEven, emitCellAudioMeasure } from "@/lib/sync/events-emit"
import type { VersionChanges } from "@/lib/sync/outbox-types"
import { recordTakeAdded } from "@/lib/history/take-steps"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { newPieceAudioId } from "./cut-take"
import {
  injectOptimisticAudioAttachment,
  notifyAudioAttachmentsChanged,
} from "./audio-attachments-bus"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { markProjectHasAudioDataSoon } from "./project-audio-state"
import { setTranscribeStatus } from "./transcribe-status"

function extForMime(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav"
  if (mimeType.includes("ogg")) return "ogg"
  if (mimeType.includes("webm")) return "webm"
  return "webm"
}

export interface DenoiseTakeArgs {
  projectId: string
  fileId: string
  cellId: string
  /** Stored id of the take to clean, e.g. "audio-cell12-…-xyz.webm". */
  sourceAudioId: string
  /** frontier-audio:// url of the source take. */
  sourceUrl: string
  author: string
  session: FrontierSession | null
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  /** Decision 11: record an Undo step for the new take, naming the take that
   *  played in its slot before. Omitted by bulk runs, which record none. */
  history?: { selectedBefore: string | null }
  /** AQU-2327: run from the Station — the cleaned take is a version, and its
   *  History row says so ("noise removed · used on line 331"). */
  versionChanges?: VersionChanges
  /**
   * AQU-2327: the take being cleaned, so the cleaned take keeps its track,
   * name, kept part, places and level — cleaning a take on an added track used
   * to land it on the main track with its margins back. Cleaning keeps the
   * length, so every window carries over as it is.
   */
  source?: {
    slot?: string | null
    label?: string | null
    trimStartMs?: number | null
    trimEndMs?: number | null
    targetOffsetMs?: number | null
    recordingsOffsetMs?: number | null
    gainDb?: number | null
    fadeInMs?: number | null
    fadeOutMs?: number | null
    /** AQU-2664: the loudness it is evened out to, carried to the cleaned
     *  take. Its new audio is unmeasured until Even out measures it. */
    evenTargetLufs?: number | null
  }
}

export interface DenoiseTakeResult {
  /** Stored id of the new cleaned take ("dn-…<.ext>"). */
  audioId: string
  url: string
  durationMs: number
}

/** Steps 1-3: clean a take's recording and upload it as a new (dn-) clip. */
async function cleanAndUpload(args: {
  projectId: string
  fileId: string
  cellId: string
  sourceUrl: string
  session: FrontierSession | null
}) {
  const { projectId, fileId, cellId, sourceUrl, session } = args
  if (!session?.jwt) throw new Error("Sign in to remove noise")

  const source = parseFrontierAudioUrl(sourceUrl)
  if (!source) throw new Error("This take can't be denoised (unsupported audio source)")
  const getSyncToken = audioSyncTokenFetcherForSession(session)

  // 1. Fetch + decode the source clip to mono 48 kHz.
  const bytes = await fetchCellAudio({
    projectId,
    fileId,
    audioId: source.audioId,
    ext: source.ext,
    getSyncToken,
  })
  const samples = await decodeToMono48k(bytes)

  // 2. Run RNNoise → WebM/Opus blob, or a WAV for a WAV take. AQU-1575: a WAV
  //    original stays a WAV; removing noise must not quietly downgrade it to
  //    compressed audio. Every other input is written as Opus, as before.
  const output = source.ext.toLowerCase() === "wav" ? "wav" : "opus"
  const { blob, durationMs, mimeType } = await denoiseMono48k(samples, { output })

  // 3. Upload as a new (denoised) take. Warm the byte cache first (FRO-355)
  //    so the new take is transcribable/playable locally straight away.
  const ext = extForMime(mimeType)
  const newId = buildDenoisedAudioId(cellId)
  await audioCachePutBlob(newId, ext, blob)
  const result = await uploadCellAudio({ projectId, fileId, audioId: newId, ext, blob, getSyncToken })
  const fullAudioId = `${result.audioId}.${result.ext}`

  setTranscribeStatus(result.audioId, { kind: "idle" })
  markProjectHasAudioDataSoon(projectId)
  const dropUpload = () => {
    void deleteCellAudio({ projectId, fileId, audioId: result.audioId, ext: result.ext, getSyncToken })
  }
  return { blob, durationMs, result, fullAudioId, dropUpload }
}

/**
 * AQU-2664: measure the cleaned take(s) right away, from the cleaned audio
 * this action holds, over each take's kept part — off the page in the
 * loudness worker, else on the page in yielding chunks. Never awaited by the
 * save: it runs after it, and any failure just leaves the take unmeasured
 * (it plays at its own volume, the fallback, until Even out measures it).
 */
async function measureCleaned(
  blob: Blob,
  where: { projectId: string; fileId: string; cellId: string; author: string; targetLang?: string },
  takes: ReadonlyArray<{ audioId: string; trimStartMs?: number | null; trimEndMs?: number | null }>,
): Promise<void> {
  try {
    const pcm = await decodeToMono48k(new Uint8Array(await blob.arrayBuffer()))
    const durationMs = Math.round((pcm.length / TARGET_RATE) * 1000)
    for (const t of takes) {
      const a = Math.min(pcm.length, Math.max(0, Math.round(((t.trimStartMs ?? 0) / 1000) * TARGET_RATE)))
      const b = t.trimEndMs != null ? Math.min(pcm.length, Math.round((t.trimEndMs / 1000) * TARGET_RATE)) : pcm.length
      // A copy: the worker takes (transfers) what it measures.
      const r = await loudnessClient().measure([pcm.slice(a, Math.max(a, b))], TARGET_RATE)
      await emitCellAudioMeasure({
        projectId: where.projectId, fileId: where.fileId, cellId: where.cellId, audioId: t.audioId, durationMs,
        loudness: { loudnessLufs: r.integratedLufs, truePeakDb: r.truePeakDb, loudnessFromMs: t.trimStartMs ?? 0, loudnessToMs: t.trimEndMs ?? null },
        ...(where.targetLang ? { targetLang: where.targetLang } : {}),
        author: where.author,
      })
    }
    notifyAudioAttachmentsChanged(where.fileId)
  } catch {
    // The fallback: unmeasured, it plays at its own volume.
  }
}

export async function denoiseTake(args: DenoiseTakeArgs): Promise<DenoiseTakeResult> {
  const { projectId, fileId, cellId, sourceAudioId, author } = args
  const { blob, durationMs, result, fullAudioId, dropUpload } = await cleanAndUpload({ ...args })

  // 4. Attach (records + selects the clip in its slot). Link back to the source
  //    take so the UI can revert. On emit failure, clean up the orphaned R2
  //    object and re-throw the original error.
  let attachEventId: string
  const src = args.source
  const slot = src?.slot ?? "recording"
  try {
    attachEventId = await emitCellAudioAttach({
      projectId,
      fileId,
      cellId,
      audioId: fullAudioId,
      url: result.url,
      slot,
      mimeType: blob.type || undefined,
      referenceAudioId: sourceAudioId,
      durationMs: Math.round(durationMs),
      ...(src?.label ? { label: src.label } : {}),
      ...(src?.trimStartMs != null ? { trimStartMs: src.trimStartMs } : {}),
      ...(src?.trimEndMs != null ? { trimEndMs: src.trimEndMs } : {}),
      ...(args.versionChanges ? { versionChanges: args.versionChanges } : {}),
      ...(args.targetLang ? { targetLang: args.targetLang } : {}),
      author,
    })
    const lane = args.targetLang ? { targetLang: args.targetLang } : {}
    if (src && (src.targetOffsetMs != null || src.recordingsOffsetMs != null)) {
      attachEventId = await emitCellAudioPlace({
        projectId, fileId, cellId, audioId: fullAudioId,
        targetOffsetMs: src.targetOffsetMs ?? null,
        recordingsOffsetMs: src.recordingsOffsetMs ?? null,
        ...lane, author,
      })
    }
    if (src && (src.gainDb != null || src.fadeInMs != null || src.fadeOutMs != null)) {
      await emitCellAudioGain({
        projectId, fileId, cellId, audioId: fullAudioId,
        gainDb: src.gainDb ?? null, fadeInMs: src.fadeInMs ?? null, fadeOutMs: src.fadeOutMs ?? null,
        ...lane, author,
      })
    }
    if (src?.evenTargetLufs != null) {
      await emitCellAudioEven({ projectId, fileId, cellId, audioId: fullAudioId, evenTargetLufs: src.evenTargetLufs, ...lane, author })
    }
  } catch (emitErr) {
    dropUpload()
    throw emitErr
  }

  // 5. Optimistically surface the cleaned take so it shows without waiting for
  //    the outbox flush + projection round-trip.
  injectOptimisticAudioAttachment(fileId, cellId, {
    audioId: fullAudioId,
    url: result.url,
    slot,
    mimeType: blob.type || null,
    voiceId: null,
    referenceAudioId: sourceAudioId,
    durationMs: Math.round(durationMs),
    trimStartMs: src?.trimStartMs ?? null,
    trimEndMs: src?.trimEndMs ?? null,
    ...(src?.label ? { label: src.label } : {}),
    ...(src?.targetOffsetMs != null ? { targetOffsetMs: src.targetOffsetMs } : {}),
    ...(src?.recordingsOffsetMs != null ? { recordingsOffsetMs: src.recordingsOffsetMs } : {}),
    ...(src?.gainDb != null ? { gainDb: src.gainDb } : {}),
    ...(src?.fadeInMs != null ? { fadeInMs: src.fadeInMs } : {}),
    ...(src?.fadeOutMs != null ? { fadeOutMs: src.fadeOutMs } : {}),
    ...(src?.evenTargetLufs != null ? { evenTargetLufs: src.evenTargetLufs } : {}),
  }, attachEventId)
  notifyAudioAttachmentsChanged(fileId)
  void measureCleaned(blob, { projectId, fileId, cellId, author, ...(args.targetLang ? { targetLang: args.targetLang } : {}) }, [
    { audioId: fullAudioId, trimStartMs: src?.trimStartMs, trimEndMs: src?.trimEndMs },
  ])
  if (args.history) {
    recordTakeAdded("denoise", { cellId, audioId: fullAudioId, slot, selectedBefore: args.history.selectedBefore }, { fileId })
  }

  return { audioId: fullAudioId, url: result.url, durationMs }
}

export interface DenoiseSplitTakeArgs {
  projectId: string
  fileId: string
  cellId: string
  /** The split take's live pieces, in clip order. They share one recording. */
  pieces: readonly AudioAttachmentOut[]
  author: string
  session: FrontierSession | null
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  /** Decision 11: record an Undo step for the new take, naming the take that
   *  played in its slot before. Omitted by bulk runs, which record none. */
  history?: { selectedBefore: string | null }
  /** AQU-2327: run from the Station (see `DenoiseTakeArgs`). */
  versionChanges?: VersionChanges
}

/**
 * AQU-1767 (Sam, 2026-10-14): "Remove noise" on a SPLIT take — clean it and
 * keep the cuts. The recording all its pieces share is cleaned once, and the
 * cleaned take is made of the same pieces: each keeps its window, its name and
 * where it sits on the timeline, on the take's own track. The first is the
 * cleaned take itself (a dn- id, so it reads as cleaned); every other piece is
 * born naming it (`pieceOf`). Each cleaned piece remembers the piece it was
 * cleaned from, so Revert goes back to the original take. Attaching chooses
 * the cleaned take; the original stays among the line's other takes.
 */
export async function denoiseSplitTake(args: DenoiseSplitTakeArgs): Promise<DenoiseTakeResult> {
  const { projectId, fileId, cellId, pieces, author, targetLang } = args
  const [first] = pieces
  if (!first) throw new Error("Nothing to clean")
  const { blob, durationMs, result, fullAudioId, dropUpload } = await cleanAndUpload({
    projectId, fileId, cellId, sourceUrl: first.url, session: args.session,
  })
  const lane = targetLang ? { targetLang } : {}
  const born = pieces.map((piece, i) => ({
    piece,
    audioId: i === 0 ? fullAudioId : newPieceAudioId(cellId, fullAudioId),
  }))
  const rootId = born[0].audioId
  let attached = 0
  try {
    for (const { piece, audioId } of born) {
      const eventId = await emitCellAudioAttach({
        projectId, fileId, cellId, audioId,
        url: result.url,
        slot: piece.slot,
        mimeType: blob.type || undefined,
        referenceAudioId: piece.audioId,
        durationMs: Math.round(durationMs),
        ...(piece.label ? { label: piece.label } : {}),
        ...(piece.trimStartMs != null ? { trimStartMs: piece.trimStartMs } : {}),
        ...(piece.trimEndMs != null ? { trimEndMs: piece.trimEndMs } : {}),
        ...(audioId !== rootId ? { pieceOf: rootId } : {}),
        ...(args.versionChanges ? { versionChanges: args.versionChanges } : {}),
        ...lane,
        author,
      })
      attached += 1
      // AQU-2267: in both timings — its place following the recordings is
      // stated beside its place following the source, so neither moves.
      const placeP = piece.targetOffsetMs != null || piece.recordingsOffsetMs != null
        ? emitCellAudioPlace({
            projectId, fileId, cellId, audioId,
            targetOffsetMs: piece.targetOffsetMs ?? null,
            recordingsOffsetMs: piece.recordingsOffsetMs ?? null,
            ...lane, author,
          })
        : null
      // AQU-2664: each cleaned piece keeps its piece's evening out.
      if (piece.evenTargetLufs != null) {
        await emitCellAudioEven({ projectId, fileId, cellId, audioId, evenTargetLufs: piece.evenTargetLufs, ...lane, author })
      }
      injectOptimisticAudioAttachment(fileId, cellId, {
        audioId,
        url: result.url,
        slot: piece.slot,
        mimeType: blob.type || null,
        voiceId: null,
        referenceAudioId: piece.audioId,
        durationMs: Math.round(durationMs),
        trimStartMs: piece.trimStartMs ?? null,
        trimEndMs: piece.trimEndMs ?? null,
        targetOffsetMs: piece.targetOffsetMs ?? null,
        recordingsOffsetMs: piece.recordingsOffsetMs ?? null,
        ...(piece.label ? { label: piece.label } : {}),
        ...(audioId !== rootId ? { pieceOf: rootId } : {}),
        ...(piece.evenTargetLufs != null ? { evenTargetLufs: piece.evenTargetLufs } : {}),
      }, placeP ?? eventId)
    }
  } catch (emitErr) {
    // Nothing of the cleaned take reached the outbox: drop the upload. Once a
    // piece has, the clip is in use and stays.
    if (attached === 0) dropUpload()
    throw emitErr
  }
  notifyAudioAttachmentsChanged(fileId)
  void measureCleaned(blob, { projectId, fileId, cellId, author, ...(targetLang ? { targetLang } : {}) },
    born.map(({ piece, audioId }) => ({ audioId, trimStartMs: piece.trimStartMs, trimEndMs: piece.trimEndMs })))
  if (args.history) {
    recordTakeAdded(
      "denoise",
      {
        cellId,
        audioId: rootId,
        slot: first.slot,
        selectedBefore: args.history.selectedBefore,
        pieces: born.slice(1).map((b) => b.audioId),
      },
      { fileId },
    )
  }
  return { audioId: rootId, url: result.url, durationMs }
}
