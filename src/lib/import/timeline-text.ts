import { v7 as uuidv7 } from "uuid"
import type { ImportedTrackPublication } from "../../../shared/timeline-import"
import { buildBulkCellsWithSpeakers } from "../import"
import { TIMELINE_CONTENT_ROLE, type FileType } from "../parsers/types"
import { bulkUploadSource, publishStagedImport } from "../sync/bulk-import"
import { createMediaCueSpecs, type MediaTextSource } from "./media-cues"

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
  await bulkUploadSource({
    projectId: args.projectId, fileId,
    file: {
      id: uuidv7(), name: artifact?.name ?? args.name,
      role: TIMELINE_CONTENT_ROLE, kind: captionFormat, fileType: captionFormat,
      anchorFileId: args.anchorFileId, orderedBy: "time",
      importFormat: captionFormat, parserVersion: "builtin:timeline-text@1",
    }, cells,
    ...(artifact ? { rawBytes: artifact.bytes, rawSourceFormat: artifact.format,
      artifactFidelity: "preserved-only" as const, updateSourceSidecar: false } : {}),
    deferPublication: true, getToken: args.getToken,
    fetchImpl: args.fetchImpl, signal: args.signal, onProgress: args.onProgress,
  })
  await publishStagedImport({
    projectId: args.projectId, fileId: args.anchorFileId,
    trackPublication: { contentFileId: fileId, trackId, name: args.name,
      ...(args.overwrite ? { overwrite: args.overwrite } : {}) },
    getToken: args.getToken, fetchImpl: args.fetchImpl, signal: args.signal,
  })
  return { fileId, trackId, cellCount: cells.length }
}
