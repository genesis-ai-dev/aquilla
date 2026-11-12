// AQU-1560: upstream files being added to an existing source link.
//
// `projects.source_link_backfill` (migration 0128) holds the pending work of
// bringing a file into a link late. auth-worker writes it when a Project Lead
// adds files from Project Settings → Source & sync; sync-worker's mirror sync
// replays those files' upstream history up to the link's cursor and, once it
// gets there, moves them into `source_link_file_ids` and clears the column.
//
// Lives in db/shared so both workers read and write the same shape.

/** One link's pending addition. */
export interface SourceLinkBackfill {
  /** UPSTREAM file ids being brought in, like `source_link_file_ids`. */
  fileIds: string[]
  /**
   * The upstream server_seq the replay has folded up to. The next replay
   * window starts after it; the replay is finished once it reaches the link's
   * cursor.
   */
  doneSeq: number
}

/**
 * Parse the column. Anything that is not an object with a non-empty list of
 * file ids reads as `null`, "nothing pending": the column is TEXT, and the safe
 * misreading of a malformed blob is to add nothing — the lead sees the file is
 * still unlinked and adds it again — rather than to replay files nobody asked
 * for. A missing or invalid `doneSeq` reads as 0, which replays from the start;
 * the replay is idempotent, so that only costs time.
 */
export function parseSourceLinkBackfill(raw: string | null | undefined): SourceLinkBackfill | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const { fileIds, doneSeq } = parsed as { fileIds?: unknown; doneSeq?: unknown }
  if (!Array.isArray(fileIds)) return null
  const ids = [...new Set(fileIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
  if (ids.length === 0) return null
  const seq = typeof doneSeq === "number" && Number.isFinite(doneSeq) && doneSeq > 0 ? Math.floor(doneSeq) : 0
  return { fileIds: ids, doneSeq: seq }
}

export function serializeSourceLinkBackfill(backfill: SourceLinkBackfill): string {
  return JSON.stringify({ fileIds: backfill.fileIds, doneSeq: backfill.doneSeq })
}

/**
 * Fold a new addition into whatever is already pending.
 *
 * Files already pending keep their progress only when nothing new joins them.
 * A new file needs its history replayed from the start, and the replay is one
 * pass over all pending files, so the pass restarts. That re-folds the files
 * already part-way in, which is safe: every mirror event id is deterministic
 * and the projection only applies a mirror newer than the row it lands on.
 */
export function mergeSourceLinkBackfill(
  pending: SourceLinkBackfill | null,
  addFileIds: readonly string[],
): SourceLinkBackfill {
  if (!pending) return { fileIds: [...new Set(addFileIds)], doneSeq: 0 }
  const already = new Set(pending.fileIds)
  const fresh = addFileIds.filter((id) => !already.has(id))
  if (fresh.length === 0) return pending
  return { fileIds: [...pending.fileIds, ...new Set(fresh)], doneSeq: 0 }
}
