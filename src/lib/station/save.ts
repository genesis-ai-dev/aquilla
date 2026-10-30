// "Save as new version" (AQU-2327, spec item 35). The edited recording is
// rendered whole (its trim, fades and volume stay on the clip — they never
// change the recording), written as 16-bit 48 kHz mono WAV, uploaded, and
// attached as a NEW take on each line that uses it: the original is kept, and
// the new one points back at it (`referenceAudioId`), the way Remove noise
// already makes a cleaned take (denoise-take.ts).
//
// Each placement keeps its track, its place in both timings and its own kept
// part, mapped through the edits so it keeps the same sound. Attaching
// chooses the new take in its slot. All of it is ONE Undo step.

import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { notifyAudioAttachmentsChanged, injectOptimisticAudioAttachment } from "@/lib/audio/audio-attachments-bus"
import type { SyncTokenFetcher } from "@/lib/audio/peaks-loader"
import { buildAudioId, deleteCellAudio, uploadCellAudio } from "@/lib/audio/upload"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { recordStep, withGroup } from "@/lib/history/history"
import { recordTakeAdded, type TakeRemoveData } from "@/lib/history/take-steps"
import { emitCellAudioAttach, emitCellAudioPlace, emitCellAudioRemove } from "@/lib/sync/events-emit"

/** One line the new version goes on, and how it sits there. */
export interface VersionPlacement {
  fileId: string
  cellId: string
  /** The take it replaces on that line. */
  fromAudioId: string
  slot: string
  label: string | null
  /** Its kept part in the NEW recording, ms; null = the edge. */
  trimStartMs: number | null
  trimEndMs: number | null
  targetOffsetMs: number | null
  recordingsOffsetMs: number | null
  /** The take that plays in that slot now (the step gives it back on Undo). */
  selectedBefore: string | null
  /**
   * Q6: one piece of a split take. The new version joins the same take as a
   * piece (`pieceOf` = the take's first piece) in the old piece's place, and
   * the old piece goes — so the other pieces keep playing, untouched, with
   * their approvals.
   */
  pieceOf?: string | null
}

export interface SaveVersionArgs {
  projectId: string
  samples: Float32Array
  rate: number
  placements: readonly VersionPlacement[]
  author: string
  targetLang?: string
  getSyncToken: SyncTokenFetcher
  /** The step's file and name (the file the Station's take lives in). */
  where: { fileId: string; fileName?: string | null }
}

export interface SavedVersion {
  /** The new take's id on each line, in `placements` order. */
  audioIds: string[]
  url: string
  durationMs: number
}

export async function saveStationVersion(args: SaveVersionArgs): Promise<SavedVersion> {
  const first = args.placements[0]
  if (!first) throw new Error("Nothing to save")
  const blob = encodeWavPcm16(args.samples, args.rate)
  const durationMs = Math.round((args.samples.length / args.rate) * 1000)
  // One stored object; on a line other than the first, a take of its own.
  const baseId = buildAudioId(first.cellId)
  await audioCachePutBlob(baseId, "wav", blob)
  const up = await uploadCellAudio({
    projectId: args.projectId,
    fileId: first.fileId,
    audioId: baseId,
    ext: "wav",
    blob,
    getSyncToken: args.getSyncToken,
  })
  const url = up.url
  const objectId = `${up.audioId}.${up.ext}`
  const lane = args.targetLang ? { targetLang: args.targetLang } : {}
  const ids: string[] = []
  let attached = 0
  try {
    await withGroup(
      { labelKey: "editor.history.stepStationVersion", fileId: args.where.fileId, fileName: args.where.fileName ?? null },
      async () => {
        for (const p of args.placements) {
          const audioId = p === first ? objectId : `${buildAudioId(p.cellId)}.${up.ext}`
          ids.push(audioId)
          const eventId = await emitCellAudioAttach({
            projectId: args.projectId,
            fileId: p.fileId,
            cellId: p.cellId,
            audioId,
            url,
            slot: p.slot,
            mimeType: "audio/wav",
            referenceAudioId: p.fromAudioId,
            durationMs,
            ...(p.label ? { label: p.label } : {}),
            ...(p.trimStartMs != null ? { trimStartMs: p.trimStartMs } : {}),
            ...(p.trimEndMs != null ? { trimEndMs: p.trimEndMs } : {}),
            ...(p.pieceOf ? { pieceOf: p.pieceOf } : {}),
            ...lane,
            author: args.author,
          })
          attached += 1
          // AQU-2267: both places, so neither timing moves.
          const placeP =
            p.targetOffsetMs != null || p.recordingsOffsetMs != null
              ? emitCellAudioPlace({
                  projectId: args.projectId,
                  fileId: p.fileId,
                  cellId: p.cellId,
                  audioId,
                  targetOffsetMs: p.targetOffsetMs,
                  recordingsOffsetMs: p.recordingsOffsetMs,
                  ...lane,
                  author: args.author,
                })
              : null
          injectOptimisticAudioAttachment(
            p.fileId,
            p.cellId,
            {
              audioId,
              url,
              slot: p.slot,
              mimeType: "audio/wav",
              voiceId: null,
              referenceAudioId: p.fromAudioId,
              durationMs,
              trimStartMs: p.trimStartMs,
              trimEndMs: p.trimEndMs,
              targetOffsetMs: p.targetOffsetMs,
              recordingsOffsetMs: p.recordingsOffsetMs,
              ...(p.label ? { label: p.label } : {}),
              ...(p.pieceOf ? { pieceOf: p.pieceOf } : {}),
            },
            placeP ?? eventId,
          )
          recordTakeAdded(
            "station",
            { cellId: p.cellId, audioId, slot: p.slot, selectedBefore: p.selectedBefore },
            { fileId: p.fileId },
          )
          if (p.pieceOf) {
            // The piece it replaces goes, in the same step; Undo brings it back.
            await emitCellAudioRemove({ projectId: args.projectId, fileId: p.fileId, cellId: p.cellId, audioId: p.fromAudioId, ...lane, author: args.author })
            recordStep<TakeRemoveData>({
              kind: "take.remove",
              data: { cellId: p.cellId, audioId: p.fromAudioId, slot: p.slot, wasSelected: true, selectedBefore: p.selectedBefore },
              labelKey: "editor.history.stepDeleteTake",
              fileId: p.fileId,
            })
          }
        }
      },
      { alwaysGroup: args.placements.length > 1 || args.placements.some((p) => p.pieceOf) },
    )
  } catch (err) {
    // Nothing reached the outbox: the upload goes too. Once one line has it,
    // the recording is in use and stays.
    if (attached === 0) {
      void deleteCellAudio({ projectId: args.projectId, fileId: first.fileId, audioId: up.audioId, ext: up.ext, getSyncToken: args.getSyncToken })
    }
    throw err
  }
  for (const fileId of new Set(args.placements.map((p) => p.fileId))) notifyAudioAttachmentsChanged(fileId)
  return { audioIds: ids, url, durationMs }
}
