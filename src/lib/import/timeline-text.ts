import { v7 as uuidv7 } from "uuid"
import type { ImportedTrackPublication } from "../../../shared/timeline-import"
import { buildBulkCellsWithSpeakers } from "../import"
import { TIMELINE_CONTENT_ROLE, type FileType } from "../parsers/types"
import { bulkUploadSource, publishStagedImport } from "../sync/bulk-import"
import { assertImportCellsWithinSizeLimit } from "./cell-size"
import { createMediaCueSpecs, type MediaTextSource } from "./media-cues"
import { normalizeTranslatableStrings, summarizeNormalizedImport } from "./normalized-manifest"

export interface ImportTimelineTextTrackArgs {
  projectId: string
  anchorFileId: string
  name: string
  source: MediaTextSource
  durationMs?: number
  /** Omit to create a new track. Set only for an explicit overwrite. */
  trackId?: string
  overwrite?: ImportedTrackPublication["overwrite"]
  getToken: (fileId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?: (uploaded: number, total: number) => void
}

/** Validate the reviewed cues before writes. Preserve the original caption
 * export separately from the edited cue values, then publish the parent track
 * reference and child reveal together. Other tracks keep their own content.
 */
export async function importTimelineTextTrack(args: ImportTimelineTextTrackArgs): Promise<{
  fileId: string; trackId: string; cellCount: number
}> {
  return createTimelineTextTrackImporter(args)()
}

/** Keep publication identity across user retries and concurrent confirmations. */
export function createTimelineTextTrackImporter(args: ImportTimelineTextTrackArgs) {
  if (!args.name.trim() || args.name.length > 120) throw new Error("Enter a track name.")
  if (args.overwrite && !args.trackId) throw new Error("Choose the track to overwrite.")
  const specs = createMediaCueSpecs(args.source.cues, args.durationMs)
  const fileId = uuidv7()
  const trackId = args.trackId ?? uuidv7()
  const artifact = args.source.artifact
  const captionFormat = artifact && ["vtt", "srt", "sbv"].includes(artifact.format)
    ? artifact.format as FileType : "vtt"
  const { cells } = buildBulkCellsWithSpeakers(specs.map(spec => ({
    id: spec.cellId, original: spec.transcription!, translated: "",
    context: args.name, group: args.name, type: "cue" as const,
    start: spec.startMs! / 1000, end: spec.endMs! / 1000,
    ...(spec.metadata ? { metadata: spec.metadata } : {}),
  })), {
    fileName: artifact?.name ?? args.name, fileType: captionFormat,
    profileId: "builtin:timeline-text", profileVersion: "1",
  })
  const fileEventId = uuidv7()
  const publicationEventId = uuidv7()
  const revealEventId = uuidv7()
  const result = { fileId, trackId, cellCount: cells.length }
  let staged = false
  let published = false
  let pending: Promise<typeof result> | undefined
  async function commit() {
    if (published) return result
    if (!staged) {
      await bulkUploadSource({
        projectId: args.projectId, fileId,
        file: {
          id: fileEventId, name: artifact?.name ?? args.name,
          role: TIMELINE_CONTENT_ROLE, kind: captionFormat, fileType: captionFormat,
          anchorFileId: args.anchorFileId, orderedBy: "time",
          importFormat: captionFormat, parserVersion: "builtin:timeline-text@1",
        }, cells,
        ...(artifact ? { rawBytes: artifact.bytes, rawSourceFormat: artifact.format,
          artifactFidelity: "preserved-only" as const, updateSourceSidecar: true } : {}),
        deferPublication: true, getToken: args.getToken,
        fetchImpl: args.fetchImpl, signal: args.signal, onProgress: args.onProgress,
      })
      staged = true
    }
    await publishStagedImport({
      projectId: args.projectId, fileId: args.anchorFileId,
      publishEventId: revealEventId,
      trackPublication: { contentFileId: fileId, trackId, name: args.name,
        eventId: publicationEventId,
        ...(args.overwrite ? { overwrite: args.overwrite } : {}) },
      getToken: args.getToken, fetchImpl: args.fetchImpl, signal: args.signal,
    })
    published = true
    return result
  }
  return () => {
    if (!pending) pending = commit().finally(() => { pending = undefined })
    return pending
  }
}

const CAPTION_FORMATS = ["vtt", "srt", "sbv"] as const
type CaptionFormat = typeof CAPTION_FORMATS[number]

export interface CaptionRowsImportArgs {
  projectId: string
  /** The linked-video file whose rows the captions become. */
  fileId: string
  source: MediaTextSource
  getToken: (fileId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?: (uploaded: number, total: number) => void
}

export interface CaptionRowsResult {
  fileId: string
  /** The hidden, deleted staging file the rows were copied from. */
  contentFileId: string
  cellCount: number
}

/**
 * AQU-1566 (option b): a linked video with no rows takes its first captions as
 * its own rows. The rows are built exactly like "Import a caption export"
 * (`emitParsedFile`: the same normalizer, `builtin:<format>` profile, no track
 * context), staged in a hidden caption file with the original bytes, then
 * copied into the parent by the server in one transaction that also makes the
 * parent a subtitle file. One staged file and one receipt per preview, so a
 * retried or double-clicked confirmation never writes twice.
 */
export function createCaptionRowsImporter(args: CaptionRowsImportArgs) {
  const artifact = args.source.artifact
  if (artifact && !(CAPTION_FORMATS as readonly string[]).includes(artifact.format)) {
    throw new Error("Choose a VTT, SRT or SBV caption file.")
  }
  const format: CaptionFormat = (artifact?.format as CaptionFormat | undefined) ?? "vtt"
  // Same wording and timing checks as a timeline track, then the caption
  // export's time order (prepareYouTubeCaptionImport sorts the same way), so
  // row order, sequence and import locators match an imported caption file.
  createMediaCueSpecs(args.source.cues)
  const strings = [...args.source.cues].sort((a, b) => a.start! - b.start!)
  const fileName = artifact?.name ?? `captions.${format}`
  const normalized = normalizeTranslatableStrings(strings, {
    fileName, fileType: format as FileType,
    profileId: `builtin:${format}`, profileVersion: "1",
  })
  const { cells } = buildBulkCellsWithSpeakers(strings, { normalizedFile: normalized })
  assertImportCellsWithinSizeLimit(fileName, cells)
  const contentFileId = uuidv7()
  const fileEventId = uuidv7()
  const genesisEventId = uuidv7()
  const result: CaptionRowsResult = { fileId: args.fileId, contentFileId, cellCount: cells.length }
  let staged = false
  let published = false
  let pending: Promise<CaptionRowsResult> | undefined
  async function commit() {
    if (published) return result
    if (!staged) {
      await bulkUploadSource({
        projectId: args.projectId, fileId: contentFileId,
        file: {
          id: fileEventId, name: fileName,
          role: TIMELINE_CONTENT_ROLE, kind: format, fileType: format,
          anchorFileId: args.fileId, orderedBy: "time",
          importFormat: format,
          parserVersion: `${normalized.profileId}@${normalized.profileVersion}`,
          importManifest: summarizeNormalizedImport(normalized),
        }, cells,
        ...(artifact ? { rawBytes: artifact.bytes, rawSourceFormat: artifact.format,
          artifactFidelity: normalized.fidelity, updateSourceSidecar: true } : {}),
        deferPublication: true, getToken: args.getToken,
        fetchImpl: args.fetchImpl, signal: args.signal, onProgress: args.onProgress,
      })
      staged = true
    }
    await publishStagedImport({
      projectId: args.projectId, fileId: args.fileId,
      captionPromotion: { contentFileId, genesisEventId },
      getToken: args.getToken, fetchImpl: args.fetchImpl, signal: args.signal,
    })
    published = true
    return result
  }
  return () => {
    if (!pending) pending = commit().finally(() => { pending = undefined })
    return pending
  }
}

export interface PromoteTrackToRowsArgs {
  projectId: string
  fileId: string
  trackId: string
  /** The track's hidden content file (`trackOverrides[trackId].contentFileId`). */
  contentFileId: string
  getToken: (fileId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** AQU-1566: an existing caption track becomes the linked video's rows; the
 * track leaves the timeline and its content file is deleted in the same step.
 * The three event ids are minted once per confirmation, so a retry after a
 * lost response is answered from the server's receipt. */
export function createTrackRowsPromoter(args: PromoteTrackToRowsArgs) {
  const promotion = {
    contentFileId: args.contentFileId, trackId: args.trackId,
    genesisEventId: uuidv7(), retireEventId: uuidv7(), deleteEventId: uuidv7(),
  }
  let done = false
  let pending: Promise<void> | undefined
  return () => {
    if (done) return Promise.resolve()
    if (!pending) {
      pending = publishStagedImport({
        projectId: args.projectId, fileId: args.fileId, captionPromotion: promotion,
        getToken: args.getToken, fetchImpl: args.fetchImpl, signal: args.signal,
      }).then(() => { done = true }).finally(() => { pending = undefined })
    }
    return pending
  }
}

export function promoteTimelineTrackToRows(args: PromoteTrackToRowsArgs): Promise<void> {
  return createTrackRowsPromoter(args)()
}

/** AQU-1566: the server refused a promotion because the linked video already
 *  has rows (someone else got there first, or the rows had not loaded). The
 *  caller shows those rows and says so instead of a raw HTTP error. Matches the
 *  refusal text of `import-caption-promotion.ts`. */
export function isRowsAlreadyThereRefusal(error: unknown): boolean {
  return error instanceof Error && /\(HTTP 409\)/.test(error.message)
    && error.message.includes("this file already has rows")
}
