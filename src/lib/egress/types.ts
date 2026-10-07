/**
 * Org data egress — shared types for the engine (src/lib/egress), the audio
 * assembly module (src/lib/export/audio-assembly.ts), and the UI
 * (src/pages/OrgDataEgress.tsx + src/components/org/egress/*).
 *
 * The egress surface lets org owners/maintainers pull everything the org has
 * stored — text in round-trip or converted formats per target lane, original
 * source documents, and audio — into one zip with a manifest.json transparency
 * record. All work is client-side over existing sync-worker read endpoints.
 */

export type EgressTextMode = "original" | "convert" | "none"

/** Uniform conversion formats — the client-side structured exporters. */
export const EGRESS_CONVERT_FORMATS = [
  "txt",
  "md",
  "tsv",
  "csv",
  "xlf",
  "tmx",
  "srt",
] as const
export type EgressConvertFormat = (typeof EGRESS_CONVERT_FORMATS)[number]

/**
 * Audio output shapes:
 * - "separate-clips": one file per cell's best audio (raw bytes when possible,
 *   trim-sliced WAV when the clip is trimmed or shared by multiple cells).
 * - "file-clip": all of a file's best audio concatenated into one WAV,
 *   document order, trims applied.
 * - "voice-clips": one concatenated WAV per cast voice (no silence).
 * - "voice-timeline": one WAV per voice on a shared timeline — clips placed at
 *   their document-order offsets, zero-filled silence while others speak; all
 *   tracks in a file have identical length.
 */
export type EgressAudioMode =
  | "none"
  | "separate-clips"
  | "file-clip"
  | "voice-clips"
  | "voice-timeline"

export interface EgressOptions {
  textMode: EgressTextMode
  /** Used when textMode === "convert", and as the fallback for file types
   *  without a native round-trip exporter when textMode === "original". */
  convertFormat: EgressConvertFormat
  /** Target lanes to export ("" = the project's default lane). */
  lanes: string[]
  /** Also export the raw original import documents (sidecar bytes). */
  includeSourceDocs: boolean
  audioMode: EgressAudioMode
  /** Reuse cached per-project exports when the project hasn't changed. */
  useCache: boolean
}

export interface EgressFileRef {
  id: string
  name: string
  type: string
}

/** One project's slice of the user's selection. */
export interface EgressProjectSelection {
  projectId: string
  projectName: string
  sourceLanguage: string
  targetLanguage: string
  files: EgressFileRef[]
}

export interface EgressSkip {
  /** What was skipped — a file name, lane, or clip identifier. */
  scope: string
  /** Human-readable reason, surfaced verbatim in the results UI + manifest. */
  reason: string
}

export interface EgressFileReport {
  fileId: string
  fileName: string
  /** Zip paths written for this file. */
  entries: string[]
  skipped: EgressSkip[]
  /** Transparency notes for entries that WERE written but not as requested —
   *  e.g. a file type with no native round-trip exporter falling back to the
   *  uniform conversion format. */
  notes?: string[]
}

export interface EgressProjectReport {
  projectId: string
  projectName: string
  /** Org-zip folder prefix this project's entries were written under (the
   *  claimed project slug, "_2"-deduped) — lets manifest readers map reports
   *  to zip folders even when two projects share a name. Absent on
   *  project-level failures that wrote nothing. */
  folder?: string
  /** Digest of the project's file list (ids + lastEditAt + counts), plus the
   *  settings digest and — when audio is exported — the audio-attachments
   *  digest (audio mutations don't move any files-projection field). */
  freshnessKey: string
  /** True when this project's entries came from the export cache. */
  fromCache: boolean
  files: EgressFileReport[]
  /** Project-level failures (token mint denied, files list failed, …). */
  errors: string[]
}

export interface EgressManifest {
  generatedAt: string
  org: { id: number; name: string }
  options: EgressOptions
  projects: EgressProjectReport[]
}

export interface EgressProgressUpdate {
  phase: "preparing" | "text" | "audio" | "zipping" | "done"
  projectName: string
  /** 0-based index of the project being processed. */
  projectIndex: number
  projectCount: number
  /** Fine-grained progress within the phase; total 0 = indeterminate. */
  done: number
  total: number
  fromCache?: boolean
}

export interface RunOrgEgressArgs {
  org: { id: number; name: string }
  selections: EgressProjectSelection[]
  options: EgressOptions
  /** Session JWT — mints per-file sync tokens internally. */
  jwt: string
  /** Account the export runs as. Partitions the export cache: a cached zip
   *  holds everything ITS user could read, so an in-place account switch
   *  (AQU-616) must miss rather than replay the previous account's data. */
  username?: string
  onProgress?: (p: EgressProgressUpdate) => void
  signal?: AbortSignal
}

export interface RunOrgEgressResult {
  blob: Blob
  manifest: EgressManifest
  /** Suggested download filename, e.g. "acme-egress-20260813.zip". */
  filename: string
}
