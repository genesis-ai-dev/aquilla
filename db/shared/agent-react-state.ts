// The react watcher's durable per-project bookmark (AQU-1846).
//
// Lives in its own table rather than the project_settings blob. Two reasons,
// both of them the bug this module replaces:
//
//   • The cursor was persisted by read-modify-writing `settings` — TEXT holding
//     blobs that run to multiple MB — every five minutes per swept project,
//     behind a version guard that could lose the race to a human settings edit
//     and silently drop the advance.
//   • The cron's candidate query ordered by `project_id` under a LIMIT, so the
//     eleventh react-enabled project by id never got a turn. The row carries
//     `lastSweptAt`, which makes the sweep a round robin instead.
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts), like every other
// module here, so the cron and the manual react-check route share one
// implementation.

import type { AquillaDb } from "../shim/postgres"

/**
 *   cursor         — epoch millis, matching `events.server_ts`. Every event at
 *                    or below it has been CONSIDERED (acted on, or
 *                    deliberately skipped). `null` means never swept; the
 *                    watcher seeds it from a bounded lookback rather than the
 *                    project's entire history.
 *   lastReactionAt — fileId → ISO timestamp of the last reaction started on
 *                    that file, the input to the per-file cooldown.
 */
export interface AgentReactState {
  cursor: number | null
  lastReactionAt: Record<string, string>
}

export const AGENT_REACT_STATE_EMPTY: AgentReactState = {
  cursor: null,
  lastReactionAt: {},
}

interface ReactStateRow {
  cursor_ms: number | string | null
  last_reaction_at: Record<string, unknown> | string | null
}

function asReactionMap(value: ReactStateRow["last_reaction_at"]): Record<string, string> {
  // The shim hands jsonb back as a parsed object, but a driver that returns it
  // as text must not take the watcher down — a cooldown map that cannot be
  // read means "no cooldowns", which the per-file gates re-establish on the
  // next reaction.
  let raw: unknown = value
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [fileId, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === "string" && at.length > 0) out[fileId] = at
  }
  return out
}

/** Tolerant like the blob reader it replaces: anything that is not a positive
 *  integer reads as "never swept" rather than throwing. */
function asCursor(value: ReactStateRow["cursor_ms"]): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** Never throws: a project with no row has never been swept. */
export async function readAgentReactState(
  db: AquillaDb,
  projectId: string,
): Promise<AgentReactState> {
  const row = await db
    .prepare("SELECT cursor_ms, last_reaction_at FROM agent_react_state WHERE project_id = ?")
    .bind(projectId)
    .first<ReactStateRow>()
  if (!row) return { cursor: null, lastReactionAt: {} }
  return { cursor: asCursor(row.cursor_ms), lastReactionAt: asReactionMap(row.last_reaction_at) }
}

/**
 * Upsert the bookmark. One statement, no version guard and no blob: the row
 * belongs to the watcher alone, so last-write-wins is the correct semantics —
 * two concurrent sweeps of one project would be the bug, not the write.
 *
 * Leaves `last_swept_at` alone; the rotation stamp is `markAgentReactSwept`,
 * which the cron applies before it sweeps so a project that short-circuits
 * still takes its turn.
 *
 * Returns false (having warned) rather than throwing, because both callers are
 * best-effort and total: a cursor that does not advance replays a window the
 * per-file cooldown already covers.
 */
export async function writeAgentReactState(
  db: AquillaDb,
  input: { projectId: string; state: AgentReactState },
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO agent_react_state (project_id, cursor_ms, last_reaction_at, updated_at)
         VALUES (?, ?, ?::jsonb, now())
         ON CONFLICT (project_id) DO UPDATE
            SET cursor_ms = EXCLUDED.cursor_ms,
                last_reaction_at = EXCLUDED.last_reaction_at,
                updated_at = now()`,
      )
      // Pass the map as a structured value: postgres.js learns the jsonb type
      // from `?::jsonb` and applies its own serializer, so pre-stringifying
      // would encode it a second time (db/shared/contextual-decisions.ts
      // documents the same trap).
      .bind(input.projectId, input.state.cursor, input.state.lastReactionAt)
      .run()
    return true
  } catch (err) {
    console.warn(`[react] cursor write failed for ${input.projectId}:`, err)
    return false
  }
}

/**
 * Move a project to the back of the rotation. The cron stamps each candidate
 * BEFORE sweeping it, so a project that short-circuits (react switched off
 * between query and sweep, Autopilot off, nothing outside the debounce window)
 * or whose sweep throws still takes its turn. Without that, such a project
 * would keep its stale `last_swept_at`, be picked first every cycle, and
 * starve the others — the very defect this table fixes.
 */
export async function markAgentReactSwept(db: AquillaDb, projectId: string): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO agent_react_state (project_id, last_swept_at, updated_at)
         VALUES (?, now(), now())
         ON CONFLICT (project_id) DO UPDATE
            SET last_swept_at = now(), updated_at = now()`,
      )
      .bind(projectId)
      .run()
  } catch (err) {
    console.warn(`[react] sweep stamp failed for ${projectId}:`, err)
  }
}

/**
 * Live projects with `agentMode.react` on, **least-recently-swept first**.
 *
 * Reads the generated `agent_react` column (migration 0123) — never by parsing
 * the multi-MB settings blobs. The LEFT JOIN is what makes the rotation fair:
 * a project with no state row has never been swept, sorts first, and so a
 * newly-switched-on project reacts on the very next cycle no matter how high
 * its id. With N react-enabled projects and a limit of L, every project is
 * visited within ceil(N / L) cycles.
 */
export async function listReactProjects(db: AquillaDb, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT ps.project_id FROM project_settings ps
         JOIN projects p ON p.id = ps.project_id
         LEFT JOIN agent_react_state s ON s.project_id = ps.project_id
        WHERE ps.agent_react
          AND p.is_active AND p.archived_at IS NULL
        ORDER BY s.last_swept_at ASC NULLS FIRST, ps.project_id ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ project_id: string }>()
  return results.map((row) => row.project_id)
}
