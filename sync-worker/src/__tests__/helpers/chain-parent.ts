// AQU-1574: the parentId a real client sends with an edit — the cell's current
// head on that side and lane.
//
// Fixtures that write events straight to the log and project them ungated used
// to send every commit with parentId null. The live route rejects that shape on
// an existing cell (a stale sibling: logged, never applied — AQU-1154), and the
// mirror fold now skips stale siblings exactly as the upstream did. Fixtures
// whose edits are meant to WIN chain them on the head with this helper.
//
// Only commits and reorders chain. A create is a genesis event (parent null), and
// a parent-null delete is the trusted tombstone that applies unconditionally
// (AQU-931), which is what those fixtures mean by it.

import type { TestDb } from "./pg-test-db"

export async function headParentFor(
  t: TestDb,
  projectId: string,
  kind: string,
  fileId: string | null | undefined,
  cellId: string | null | undefined,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!fileId || !cellId || !/^(source|target)\.cell\.(commit|reorder)$/.test(kind)) return null
  const side = kind.startsWith("source.") ? "source" : "target"
  const lane = side === "target" && typeof payload.targetLang === "string" ? payload.targetLang : ""
  const r = await t.pg.query<{ event_id: string }>(
    `SELECT event_id FROM cells
      WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = $4 AND target_lang = $5`,
    [projectId, fileId, cellId, side, lane],
  )
  return r.rows[0]?.event_id ?? null
}
