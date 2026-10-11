// Per-request read memo for the settings rows authorize() and the events
// route consult while deciding a batch: project_settings, org_settings, and
// the project -> org_id hop.
//
// WHY: each authority helper (assignment / timing / line-creation /
// track-editing) used to re-read its settings row PER EVENT, and the route
// kept its own separate project_settings memo — so an outbox flush of N
// contributor events paid up to N+1 identical Hyperdrive round-trips for a row
// that nothing in the batch can change. No event kind mutates these tables
// (their only writers are the migrate-settings route and auth-worker), so a
// memo scoped to one request can never serve a stale read to any event in
// that request.
//
// AQU-1840: and the project_settings read is no longer the blob. It selects the
// `wp_*` generated columns (migration 0159, write-path-settings.ts) — the
// eleven keys this path reads — so the one remaining per-request load stopped
// detoasting and shipping a multi-MB TEXT column to answer "is this lane
// archived?". If those columns are missing (0159 not applied) the read falls
// back to the blob and narrows it in the Worker, so the answers are identical
// either way.
//
// CONTRACT — deliberately thin so each consumer keeps its own fail-safe:
//   - a missing row, or a blob that will not parse, resolves `null` (every
//     consumer already treats "no settings" and "unparseable settings" the
//     same way — locked / off / no carve-out);
//   - a DATABASE failure REJECTS (after the fallback read has failed too), and
//     the rejection is memoized like any other result. The consumers that must
//     never 500 the batch (timing / line-creation / track-editing / the route's
//     own read) wrap their call in a try; the one that previously let the error
//     escape (self-assignment) still does. Byte-for-byte the same outcomes as before, minus the repeats.
//
// Construct one per request (route.ts) and thread it through authorize(); a
// caller without one gets a fresh throwaway cache, so every existing call site
// and test keeps working unchanged.

import type { AquillaDb } from '../../../db/shim/postgres'
import {
  WRITE_PATH_COLUMNS,
  WRITE_PATH_COLUMN_LIST,
  writePathSettingsFromRow,
  type WritePathSettings,
} from './write-path-settings'

export interface RequestCache {
  /**
   * The write path's projection of `project_settings.settings` (AQU-1840) — the
   * eleven keys POST /events reads, never the blob. Null when the project has
   * no settings row.
   */
  writePathSettings(projectId: string): Promise<WritePathSettings | null>
  /** Parsed `org_settings.settings` for the org, or null. */
  orgSettings(orgId: number): Promise<Record<string, unknown> | null>
  /** `projects.org_id` for the project, or null when the project has no org (or no row). */
  projectOrgId(projectId: string): Promise<number | null>
}

/**
 * The pre-0159 read: the whole blob, narrowed to the projected keys in the
 * Worker. It loads a column the table's comment calls multi-MB, so it runs only
 * after the column read has failed.
 */
async function writePathSettingsFromBlob(
  db: AquillaDb,
  projectId: string,
): Promise<WritePathSettings | null> {
  const row = await db
    .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
    .bind(projectId)
    .first<{ settings: string | null }>()
  const parsed = parseSettings(row?.settings)
  if (!parsed) return null
  const out: Record<string, unknown> = {}
  for (const key of Object.values(WRITE_PATH_COLUMNS)) {
    if (parsed[key] !== undefined && parsed[key] !== null) out[key] = parsed[key]
  }
  return out as WritePathSettings
}

function parseSettings(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const WRITE_PATH_SELECT = `SELECT ${WRITE_PATH_COLUMN_LIST.join(', ')} FROM project_settings WHERE project_id = ?`

export function makeRequestCache(db: AquillaDb): RequestCache {
  const projectSettings = new Map<string, Promise<WritePathSettings | null>>()
  const orgSettings = new Map<number, Promise<Record<string, unknown> | null>>()
  const projectOrgIds = new Map<string, Promise<number | null>>()

  const memo = <K, V>(store: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> => {
    let pending = store.get(key)
    if (!pending) {
      pending = load()
      store.set(key, pending)
    }
    return pending
  }

  return {
    writePathSettings: (projectId) =>
      memo(projectSettings, projectId, async () => {
        try {
          const row = await db
            .prepare(WRITE_PATH_SELECT)
            .bind(projectId)
            .first<Record<string, unknown>>()
          return row ? writePathSettingsFromRow(row) : null
        } catch {
          // Most likely 0159 is not applied yet, so the columns do not exist.
          // Any other failure lands in the same place: the blob read either
          // answers, or rejects and the caller sees the same rejection it saw
          // before this projection existed (see CONTRACT above).
          return writePathSettingsFromBlob(db, projectId)
        }
      }),
    orgSettings: (orgId) =>
      memo(orgSettings, orgId, async () => {
        const row = await db
          .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
          .bind(orgId)
          .first<{ settings: string | null }>()
        return parseSettings(row?.settings)
      }),
    projectOrgId: (projectId) =>
      memo(projectOrgIds, projectId, async () => {
        const row = await db
          .prepare(`SELECT org_id FROM projects WHERE id = ?`)
          .bind(projectId)
          .first<{ org_id: number | null }>()
        return row?.org_id ?? null
      }),
  }
}
