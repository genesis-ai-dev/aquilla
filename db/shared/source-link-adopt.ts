// AQU-1679: files of a linked project that stand in for upstream files.
//
// `projects.source_link_adopt` (migration 0137) records, for a live link, which
// of the project's OWN files follow which upstream files — the "replace the
// source in my existing file" choice in the link flow. auth-worker writes it
// with the link; sync-worker's mirror sync matches each pending file's lines to
// the upstream's (events/link-adopt.ts) and from then on writes that upstream
// file's source onto the project's file instead of adding a mirrored copy.
//
// Lives in db/shared so both workers read and write the same shape.

/** One link's adopted files. */
export interface SourceLinkAdoption {
  /** UPSTREAM file id → the file in this project that follows it. */
  files: Record<string, string>
  /**
   * UPSTREAM file ids (keys of `files`) whose lines have not been matched to
   * the upstream's yet. The mirror sync matches them before anything else and
   * removes them from this list.
   */
  pending: string[]
}

/**
 * Parse the column. Anything that is not an object with at least one
 * upstream-file → file entry reads as `null`, "no adopted files": the column
 * is TEXT, and the safe misreading of a malformed blob is the link's ordinary
 * behaviour — the upstream file arrives as its own copy, which a lead can see
 * and delete — rather than a mirror writing into a file it was never pointed
 * at. `pending` entries with no `files` entry are dropped for the same reason.
 */
export function parseSourceLinkAdoption(raw: string | null | undefined): SourceLinkAdoption | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const { files, pending } = parsed as { files?: unknown; pending?: unknown }
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null
  const clean: Record<string, string> = {}
  const taken = new Set<string>()
  for (const [upstreamFileId, fileId] of Object.entries(files as Record<string, unknown>)) {
    if (!upstreamFileId || typeof fileId !== "string" || !fileId) continue
    // One file cannot stand in for two upstream files; the first claim wins.
    if (taken.has(fileId)) continue
    taken.add(fileId)
    clean[upstreamFileId] = fileId
  }
  if (Object.keys(clean).length === 0) return null
  const stillPending = Array.isArray(pending)
    ? [...new Set(pending.filter((id): id is string => typeof id === "string" && id in clean))]
    : []
  return { files: clean, pending: stillPending }
}

export function serializeSourceLinkAdoption(adoption: SourceLinkAdoption): string {
  return JSON.stringify({ files: adoption.files, pending: adoption.pending })
}
