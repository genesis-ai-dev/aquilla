// AQU-2549: copies that were joined into one of the project's own files.
//
// "Join a copy into my file" (link-adopt.ts) gives the project's own file the
// source and sends the copy the link brought in to Recently deleted. Restoring
// that copy would bring back a second file that no longer follows the source
// and cannot be joined again, so the restore is refused (route.ts) and the
// Recently deleted list says why (files-read-route.ts).
//
// A copy is known by its identity, never by name: the id the link gives its
// copy of an upstream file (`deterministicDownstreamFileId`), for an upstream
// file one of the project's own files now follows (`source_link_adopt`).

import type { AquillaDb } from '../../../db/shim/postgres'
import { deterministicDownstreamFileId, isUndefinedColumn } from './link-sync'
import { parseSourceLinkAdoption } from '../../../db/shared/source-link-adopt'

/** The project's own file a copy was joined into. */
export interface JoinedInto {
  fileId: string
  name: string
}

/** Copy id → the file it was joined into, for every joined copy of `projectId`. */
export async function loadJoinedCopies(db: AquillaDb, projectId: string): Promise<Map<string, JoinedInto>> {
  const joined = new Map<string, JoinedInto>()
  let raw: string | null | undefined
  try {
    const row = await db
      .prepare('SELECT source_link_adopt FROM projects WHERE id = ?')
      .bind(projectId)
      .first<{ source_link_adopt: string | null }>()
    raw = row?.source_link_adopt
  } catch (err) {
    // Migration 0140 not applied: nothing was ever joined.
    if (!isUndefinedColumn(err)) throw err
    return joined
  }
  const adoption = parseSourceLinkAdoption(raw)
  if (!adoption) return joined
  const pending = new Set(adoption.pending)
  const pairs = Object.entries(adoption.files)
    // A join not run yet has not removed anything.
    .filter(([upstreamFileId]) => !pending.has(upstreamFileId))
    .map(([upstreamFileId, fileId]) => ({ copyId: deterministicDownstreamFileId(projectId, upstreamFileId), fileId }))
    .filter((pair) => pair.copyId !== pair.fileId)
  if (pairs.length === 0) return joined
  const ids = [...new Set(pairs.map((pair) => pair.fileId))]
  const { results } = await db
    .prepare(`SELECT id, name FROM files WHERE project_id = ? AND id IN (${ids.map(() => '?').join(', ')})`)
    .bind(projectId, ...ids)
    .all<{ id: string; name: string }>()
  const nameOf = new Map(results.map((row) => [row.id, row.name]))
  for (const pair of pairs) {
    const name = nameOf.get(pair.fileId)
    if (name !== undefined) joined.set(pair.copyId, { fileId: pair.fileId, name })
  }
  return joined
}

/** The refusal's reason, naming the file. Plain English: it reaches the log
 *  and a client that shows a refused event's reason. */
export function joinedCopyRestoreReason(into: JoinedInto): string {
  return `this file was joined into "${into.name}", which now follows the source project; it cannot be restored`
}
