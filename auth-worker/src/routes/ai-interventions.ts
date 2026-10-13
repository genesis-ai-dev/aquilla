// AI intervention audit trail (AQU-1656). Mounted at /api/v2/projects.
//
//   POST /:projectId/ai-interventions                record one model call
//   GET  /:projectId/cells/:cellId/ai-interventions  a cell's interventions
//   GET  /:projectId/ai-interventions/:id/trace      prompt + raw output
//
// One model call drafts one or more cells. The call's full trace (prompt
// messages + raw output) is ONE R2 object shared by its cells; each cell gets a
// Postgres row with what it received, the examples the prompt used and the
// cell head the draft was based on. The row id is also written into the
// committed draft's `ai_draft.interventionId` by the client, which is how a
// viewer tells a current intervention from one made on an older version.
//
// Recording is best-effort from the client's side (it never blocks a draft),
// so this route validates hard and stores nothing partial: the trace is put
// before the rows, and a failed put degrades to rows with trace_key NULL.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { ROLE } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"

type AppEnv = { Bindings: Env; Variables: Variables }
const aiInterventions = new Hono<AppEnv>()

const MAX_CELLS = 60
const MAX_MESSAGES = 20
const MAX_MESSAGE_CHARS = 200_000
const MAX_OUTPUT_CHARS = 20_000
const MAX_RAW_OUTPUT_CHARS = 200_000
const MAX_EXAMPLES = 50
const LIST_LIMIT = 50

const id = z.string().trim().min(1).max(255)

const recordSchema = z.object({
  callId: id,
  kind: z.enum(["draft", "smart_edit", "harmonize"]),
  mode: z.string().trim().min(1).max(32),
  model: z.string().trim().min(1).max(255),
  provider: z.string().trim().min(1).max(64),
  lane: z.string().max(64).default(""),
  messages: z
    .array(z.object({ role: z.string().max(32), content: z.string().max(MAX_MESSAGE_CHARS) }))
    .min(1)
    .max(MAX_MESSAGES),
  rawOutput: z.string().max(MAX_RAW_OUTPUT_CHARS),
  cells: z
    .array(
      z.object({
        interventionId: id,
        fileId: id,
        cellId: id,
        basedOnEventId: z.string().max(255).nullable().optional(),
        output: z.string().max(MAX_OUTPUT_CHARS),
        exampleCellIds: z.array(z.string().max(255)).max(MAX_EXAMPLES).default([]),
      }),
    )
    .min(1)
    .max(MAX_CELLS),
})

export interface AiInterventionRow {
  id: string
  callId: string
  lane: string
  fileId: string
  cellId: string
  kind: "draft" | "smart_edit" | "harmonize"
  mode: string
  outcome: string
  model: string
  provider: string
  basedOnEventId: string | null
  output: string
  exampleCellIds: string[]
  hasTrace: boolean
  userId: string
  createdAt: number
}

type RawRow = {
  id: string
  call_id: string
  lane: string
  file_id: string
  cell_id: string
  kind: AiInterventionRow["kind"]
  mode: string
  outcome: string
  model: string
  provider: string
  based_on_event_id: string | null
  output: string
  example_cell_ids: string
  trace_key: string | null
  user_id: string
  created_at: number | string
}

function parseIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

function toRow(r: RawRow): AiInterventionRow {
  return {
    id: r.id,
    callId: r.call_id,
    lane: r.lane,
    fileId: r.file_id,
    cellId: r.cell_id,
    kind: r.kind,
    mode: r.mode,
    outcome: r.outcome,
    model: r.model,
    provider: r.provider,
    basedOnEventId: r.based_on_event_id,
    output: r.output,
    exampleCellIds: parseIds(r.example_cell_ids),
    hasTrace: r.trace_key !== null,
    userId: r.user_id,
    createdAt: Number(r.created_at),
  }
}

/** R2 key for one call's trace. Project-prefixed so a project purge can sweep it. */
export function traceKey(projectId: string, callId: string): string {
  return `ai-interventions/${encodeURIComponent(projectId)}/${encodeURIComponent(callId)}.json`
}

aiInterventions.post(
  "/:projectId/ai-interventions",
  authMiddleware,
  zValidator("json", recordSchema),
  async (c) => {
    const projectId = c.req.param("projectId")
    const input = c.req.valid("json")
    const user = c.get("user")
    // Recording an AI draft is part of writing one: the same floor as the
    // target.cell.commit the draft itself needs.
    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role || role.level < ROLE.CONTRIBUTOR) {
      return c.json({ error: "permission_denied", message: "Contributor access is required." }, 403)
    }

    let storedKey: string | null = null
    if (c.env.SNAPSHOTS) {
      const key = traceKey(projectId, input.callId)
      try {
        await c.env.SNAPSHOTS.put(
          key,
          JSON.stringify({ messages: input.messages, output: input.rawOutput }),
          { httpMetadata: { contentType: "application/json" } },
        )
        storedKey = key
      } catch (err) {
        console.warn("[ai-interventions] trace put failed:", err)
      }
    }

    const now = Date.now()
    const db = c.env.AQUILLA_PG
    await db.batch(
      input.cells.map((cell) =>
        db
          .prepare(
            `INSERT INTO ai_interventions
               (id, project_id, call_id, lane, file_id, cell_id, kind, mode, outcome,
                model, provider, based_on_event_id, output, example_cell_ids,
                trace_key, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING`,
          )
          .bind(
            cell.interventionId,
            projectId,
            input.callId,
            input.lane,
            cell.fileId,
            cell.cellId,
            input.kind,
            input.mode,
            input.model,
            input.provider,
            cell.basedOnEventId ?? null,
            cell.output,
            JSON.stringify(cell.exampleCellIds),
            storedKey,
            String(user.id),
            now,
          ),
      ),
    )
    return c.json({ ok: true, traceStored: storedKey !== null })
  },
)

aiInterventions.get("/:projectId/cells/:cellId/ai-interventions", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const cellId = c.req.param("cellId") ?? ""
  const lane = c.req.query("lane") ?? ""
  const role = await resolveProjectRole(c.env, c.get("user"), projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return c.json({ error: "permission_denied", message: "Project access is required." }, 403)
  }
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT id, call_id, lane, file_id, cell_id, kind, mode, outcome, model, provider,
            based_on_event_id, output, example_cell_ids, trace_key, user_id, created_at
       FROM ai_interventions
      WHERE project_id = ? AND cell_id = ? AND lane = ?
      ORDER BY created_at DESC
      LIMIT ${LIST_LIMIT}`,
  )
    .bind(projectId, cellId, lane)
    .all<RawRow>()
  return c.json({ interventions: (results ?? []).map(toRow) })
})

aiInterventions.get("/:projectId/ai-interventions/:id/trace", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const role = await resolveProjectRole(c.env, c.get("user"), projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return c.json({ error: "permission_denied", message: "Project access is required." }, 403)
  }
  // The key comes from the row, never from the request: a viewer of one
  // project cannot name another project's object.
  const row = await c.env.AQUILLA_PG.prepare(
    "SELECT trace_key FROM ai_interventions WHERE project_id = ? AND id = ?",
  )
    .bind(projectId, c.req.param("id") ?? "")
    .first<{ trace_key: string | null }>()
  if (!row) return c.json({ error: "not_found", message: "No such intervention." }, 404)
  if (!row.trace_key || !c.env.SNAPSHOTS) {
    return c.json({ error: "trace_unavailable", message: "The prompt for this intervention was not stored." }, 404)
  }
  const obj = await c.env.SNAPSHOTS.get(row.trace_key)
  if (!obj) return c.json({ error: "trace_unavailable", message: "The prompt for this intervention was not stored." }, 404)
  return c.json(await obj.json())
})

export default aiInterventions
