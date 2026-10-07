// Cache key half #1: digests of what the project currently contains. The base
// digest comes from one cheap fetchProjectFiles call — commits bump their
// file's lastEditAt, imports/deletes change the id set, renames change the
// name, and validate/unvalidate moves approvedCount. Audio mutations (attach,
// trim, take select) do NOT move any files-projection field, so the
// orchestrator folds a separate digest of the per-file audio-attachments
// listings (computeAudioFreshness) — and of the export-relevant settings
// (computeSettingsFreshness) — into the final key via combineFreshness.

import type { FileSummary } from "@/lib/sync/cells-read-types"
import type { FileAudioAttachmentsResponse } from "@/lib/sync/cell-audio-read-types"
import { canonicalJson } from "./options-hash"

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
}

/** sha256 hex over the sorted per-file lines — sorted so server-side recency
 *  reordering doesn't fake a content change. The name is JSON-quoted so a ":"
 *  inside it can't shift fields; it catches renames, and approvedCount catches
 *  validate/unvalidate flips that leave lastEditAt alone. */
export async function computeProjectFreshness(files: FileSummary[]): Promise<string> {
  const lines = files
    .map(
      (f) =>
        `${f.fileId}:${JSON.stringify(f.name)}:${f.lastEditAt}:${f.cellCount}:${f.approvedCount}:${f.filledCount}:${f.wordCount}`,
    )
    .sort()
  return sha256Hex(new TextEncoder().encode(lines.join("\n")))
}

/**
 * Stable digest of the per-file audio-attachments listings. Per cell: the
 * sorted attachment set (audioId + trim window + voiceId) and both selected
 * slots — every mutation that changes exported audio (new take, take select,
 * trim, voice reassign, delete) moves it, while files-projection fields don't.
 */
export async function computeAudioFreshness(
  listings: ReadonlyMap<string, FileAudioAttachmentsResponse>,
): Promise<string> {
  const lines: string[] = []
  for (const [fileId, listing] of listings) {
    for (const [cellId, cell] of Object.entries(listing.cells)) {
      const attachments = Object.entries(cell.attachments)
        .map(
          ([audioId, a]) =>
            `${audioId},${a.trimStartMs ?? ""},${a.trimEndMs ?? ""},${a.voiceId ?? ""}`,
        )
        .sort()
        .join(";")
      lines.push(
        `${fileId}/${cellId}:${cell.selectedAudioId ?? ""}:${cell.selectedGeneratedVoiceAudioId ?? ""}:${attachments}`,
      )
    }
  }
  lines.sort()
  return sha256Hex(new TextEncoder().encode(lines.join("\n")))
}

/** Digest of export-relevant settings/selection context (ttsSettings cast,
 *  target lanes, selection languages) — these shape output bytes without ever
 *  touching the files projection. Canonical JSON, so key order is irrelevant. */
export async function computeSettingsFreshness(payload: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(payload)))
}

/** Fold component digests into the one freshnessKey stored in cache+manifest. */
export async function combineFreshness(parts: readonly string[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(parts.join("\n")))
}
