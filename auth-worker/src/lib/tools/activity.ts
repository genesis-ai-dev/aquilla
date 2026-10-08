// Aquilla Tools — the activity read behind the Tools page's activity log and
// "revert everything this tool did since T".
//
// Reads the events the sync-worker stamped with provenance.origin = 'tool'
// (verified against project_tool_versions at write time), the value each
// touched cell held before the tool's first write in the window, and each
// touched cell's live head. Planning is shared/tools/revert.ts (pure); the
// client emits the compensating events through the ordinary outbox.
//
// PROTOTYPE NOTE: the events table is owned by sync-worker; this read lives in
// auth-worker next to the rest of the tools API for now. Production moves it
// behind a sync-worker read route.

import type { ToolWrite, TouchedCellState } from "../../../../shared/tools/revert"

export const MAX_ACTIVITY_EVENTS = 2000

export interface ToolActivityEvent {
  id: string
  kind: string
  fileId: string | null
  cellId: string | null
  author: string
  serverTs: number
  version: number | null
  verified: boolean
  value: string | null
}

export interface ToolActivity {
  events: ToolActivityEvent[]
  writes: ToolWrite[]
  cells: TouchedCellState[]
  truncated: boolean
}

interface EventRow {
  id: string
  kind: string
  file_id: string | null
  cell_id: string | null
  parent_id: string | null
  payload: string
  author: string
  server_ts: number | string
  server_seq: number | string
  provenance: unknown
}

function parseObject(v: unknown): Record<string, unknown> {
  let parsed: unknown = v
  if (typeof v === "string") {
    try {
      parsed = JSON.parse(v)
    } catch {
      return {}
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ")
}

export async function readToolActivity(
  db: AquillaDb,
  projectId: string,
  toolId: string,
  sinceMs: number,
): Promise<ToolActivity> {
  const { results: rows } = await db
    .prepare(
      `SELECT id, kind, file_id, cell_id, parent_id, payload, author, server_ts, server_seq, provenance
         FROM events
        WHERE project_id = ? AND provenance->>'origin' = 'tool' AND provenance->>'toolId' = ?
          AND server_ts >= ?
        ORDER BY server_seq ASC
        LIMIT ${MAX_ACTIVITY_EVENTS + 1}`,
    )
    .bind(projectId, toolId, sinceMs)
    .all<EventRow>()
  const truncated = rows.length > MAX_ACTIVITY_EVENTS
  const events = rows.slice(0, MAX_ACTIVITY_EVENTS)

  const writes: ToolWrite[] = []
  const activity: ToolActivityEvent[] = []
  // First tool commit per slot → its parent is the "before" value.
  const firstParentBySlot = new Map<string, string | null>()
  for (const r of events) {
    const payload = parseObject(r.payload)
    const prov = parseObject(r.provenance)
    const targetLang = str(payload.targetLang) ?? ""
    activity.push({
      id: r.id,
      kind: r.kind,
      fileId: r.file_id,
      cellId: r.cell_id,
      author: r.author,
      serverTs: Number(r.server_ts),
      version: typeof prov.version === "number" ? prov.version : null,
      verified: prov.verified === true,
      value: str(payload.value),
    })
    if (!r.file_id || !r.cell_id) continue
    writes.push({
      eventId: r.id,
      kind: r.kind,
      fileId: r.file_id,
      cellId: r.cell_id,
      targetLang,
      serverSeq: Number(r.server_seq),
      parentId: r.parent_id,
      editEventId: str(payload.editEventId),
    })
    if (r.kind === "target.cell.commit") {
      const key = `${r.file_id}\u0000${r.cell_id}\u0000${targetLang}`
      if (!firstParentBySlot.has(key)) firstParentBySlot.set(key, r.parent_id)
    }
  }

  // Values before the window.
  const parentIds = [...new Set([...firstParentBySlot.values()].filter((v): v is string => !!v))]
  const priorById = new Map<string, { value: string; valueHtml: string | null }>()
  if (parentIds.length > 0) {
    const { results } = await db
      .prepare(`SELECT id, kind, payload FROM events WHERE project_id = ? AND id IN (${placeholders(parentIds.length)})`)
      .bind(projectId, ...parentIds)
      .all<{ id: string; kind: string; payload: string }>()
    for (const p of results) {
      const payload = parseObject(p.payload)
      // A target chain can start on a source event (the cell came from the
      // importer): there was no translation before, so the prior value is "".
      const isTarget = p.kind.startsWith("target.")
      priorById.set(p.id, {
        value: isTarget ? (str(payload.value) ?? "") : "",
        valueHtml: isTarget ? str(payload.valueHtml) : null,
      })
    }
  }

  // Live heads of every touched cell.
  const cellIds = [...new Set(writes.map((w) => w.cellId))]
  const touchedSlots = new Set(writes.map((w) => `${w.fileId}\u0000${w.cellId}\u0000${w.targetLang}`))
  const cells: TouchedCellState[] = []
  if (cellIds.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT file_id, cell_id, target_lang, lane_id, event_id, value, last_editor, source_event_id
           FROM cells
          WHERE project_id = ? AND side = 'target' AND cell_id IN (${placeholders(cellIds.length)})`,
      )
      .bind(projectId, ...cellIds)
      .all<{
        file_id: string
        cell_id: string
        target_lang: string
        lane_id: string | null
        event_id: string
        value: string
        last_editor: string | null
        source_event_id: string | null
      }>()
    for (const c of results) {
      const key = `${c.file_id}\u0000${c.cell_id}\u0000${c.target_lang}`
      if (!touchedSlots.has(key)) continue
      const parent = firstParentBySlot.get(key)
      const prior = parent ? priorById.get(parent) : undefined
      cells.push({
        fileId: c.file_id,
        cellId: c.cell_id,
        targetLang: c.target_lang,
        laneId: c.lane_id,
        headEventId: c.event_id,
        headValue: c.value,
        headAuthor: c.last_editor,
        sourceEventId: c.source_event_id,
        priorValue: prior?.value ?? "",
        priorValueHtml: prior?.valueHtml ?? null,
      })
    }
  }

  return { events: activity, writes, cells, truncated }
}
