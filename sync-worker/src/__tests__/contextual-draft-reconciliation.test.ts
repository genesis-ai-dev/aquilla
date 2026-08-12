// AQU-826: a human target commit is the durable review boundary for an
// Autopilot proposal. The projection that wins AD-2 arbitration must resolve
// the proposal in the same database batch; a secondary client bookkeeping
// request is only an accelerator and may race, fail, or never arrive.

import { describe, expect, it } from "vitest"
import {
  buildEventProjectionStmts,
  type PersistedEvent,
} from "../events/event-projection"
import { handleRebuildProjectionRequest } from "../events/rebuild"
import type { ChainSlot } from "../events/chain-claims"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "project-contextual-draft"
const FILE = "file-contextual-draft"
const REVIEWER = "translator"
const COMMIT_TIME = Date.UTC(2026, 7, 11, 18, 30, 0)

async function seedScope(t: TestDb): Promise<void> {
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by)
     VALUES ($1, 'Contextual drafts', 1)`,
    [PROJECT],
  )
  await t.pg.query(
    `INSERT INTO files (id, project_id, name, event_id)
     VALUES ($1, $2, 'Genesis', 'file-created')`,
    [FILE, PROJECT],
  )
  await t.pg.query(
    `INSERT INTO contextual_runs (id, project_id, file_id, target_lang, status)
     VALUES
       ('run-default', $1, $2, '', 'done'),
       ('run-french', $1, $2, 'fr', 'done')`,
    [PROJECT, FILE],
  )
}

async function seedDraft(
  t: TestDb,
  input: { id: string; runId?: string; cellId: string; text: string; createdAt?: number },
): Promise<void> {
  await t.pg.query(
    `INSERT INTO contextual_drafts
        (id, run_id, project_id, file_id, cell_id, text, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'proposed', to_timestamp($7::double precision / 1000.0))`,
    [
      input.id,
      input.runId ?? "run-default",
      PROJECT,
      FILE,
      input.cellId,
      input.text,
      input.createdAt ?? COMMIT_TIME - 60_000,
    ],
  )
}

function targetCommit(input: {
  id: string
  cellId: string
  value: string
  targetLang?: string
  parentId?: string | null
}): PersistedEvent<"target.cell.commit"> {
  return {
    id: input.id,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: input.cellId,
    parentId: input.parentId ?? null,
    kind: "target.cell.commit",
    author: REVIEWER,
    payload: {
      value: input.value,
      ...(input.targetLang === undefined ? {} : { targetLang: input.targetLang }),
    },
    clientTs: COMMIT_TIME - 10,
    serverTs: COMMIT_TIME,
  }
}

async function project(
  t: TestDb,
  event: PersistedEvent<"target.cell.commit">,
  chainGate?: ChainSlot,
): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts, { chainGate })
  await t.db.batch(stmts)
}

async function draftRow(t: TestDb, id: string): Promise<Record<string, unknown>> {
  const result = await t.pg.query<Record<string, unknown>>(
    `SELECT id, status, reviewed_at, reviewed_by
       FROM contextual_drafts WHERE id = $1`,
    [id],
  )
  const row = result.rows[0]
  if (!row) throw new Error(`missing draft ${id}`)
  return row
}

describe("target.cell.commit contextual draft reconciliation", () => {
  it("applies an exact proposal and supersedes a different proposal with review metadata", async () => {
    const t = await makeTestDb()
    try {
      await seedScope(t)
      await seedDraft(t, { id: "draft-exact", cellId: "cell-exact", text: "Exact proposal" })
      await seedDraft(t, { id: "draft-different", cellId: "cell-different", text: "Old proposal" })

      await project(t, targetCommit({
        id: "0198a123-0000-7000-8000-000000000001",
        cellId: "cell-exact",
        value: "Exact proposal",
      }))
      await project(t, targetCommit({
        id: "0198a123-0000-7000-8000-000000000002",
        cellId: "cell-different",
        value: "Human translation",
      }))

      const exact = await draftRow(t, "draft-exact")
      expect(exact.status).toBe("applied")
      expect(exact.reviewed_by).toBe(REVIEWER)
      expect(new Date(String(exact.reviewed_at)).getTime()).toBe(COMMIT_TIME)

      const different = await draftRow(t, "draft-different")
      expect(different.status).toBe("superseded")
      expect(different.reviewed_by).toBe(REVIEWER)
      expect(new Date(String(different.reviewed_at)).getTime()).toBe(COMMIT_TIME)

      const activity = await t.pg.query<Record<string, unknown>>(
        `SELECT id, kind, status, summary, details, created_at
           FROM contextual_run_events
          ORDER BY summary`,
      )
      expect(activity.rows).toHaveLength(2)
      expect(activity.rows.map((event) => event.id)).toEqual([
        "0198a123-0000-7000-8000-000000000001",
        "0198a123-0000-7000-8000-000000000002",
      ])
      expect(activity.rows).toEqual([
        expect.objectContaining({
          kind: "draft_reviewed",
          status: "applied",
          summary: "Draft applied",
          details: {
            draftId: "draft-exact",
            cellId: "cell-exact",
            outcome: "applied",
          },
        }),
        expect.objectContaining({
          kind: "draft_reviewed",
          status: "superseded",
          summary: "Draft superseded",
          details: {
            draftId: "draft-different",
            cellId: "cell-different",
            outcome: "superseded",
          },
        }),
      ])
      expect(activity.rows.every(
        (event) => new Date(String(event.created_at)).getTime() === COMMIT_TIME,
      )).toBe(true)
    } finally {
      await t.close()
    }
  })

  it("does not reconcile another lane or a commit that lost AD-2 arbitration", async () => {
    const t = await makeTestDb()
    try {
      await seedScope(t)
      await seedDraft(t, { id: "draft-default", cellId: "cell-lane", text: "Default proposal" })
      await project(t, targetCommit({
        id: "0198a123-0000-7000-8000-000000000003",
        cellId: "cell-lane",
        value: "Default proposal",
        targetLang: "fr",
      }))
      expect(await draftRow(t, "draft-default")).toMatchObject({
        status: "proposed",
        reviewed_at: null,
        reviewed_by: null,
      })

      await seedDraft(t, { id: "draft-loser", cellId: "cell-loser", text: "Losing branch" })
      const slot: ChainSlot = {
        projectId: PROJECT,
        fileId: FILE,
        cellId: "cell-loser",
        parentKey: "existing-parent",
      }
      await t.pg.query(
        `INSERT INTO chain_claims
            (project_id, file_id, cell_id, parent_key, event_id)
         VALUES ($1, $2, $3, $4, 'winning-sibling')`,
        [slot.projectId, slot.fileId, slot.cellId, slot.parentKey],
      )
      await project(t, targetCommit({
        id: "0198a123-0000-7000-8000-000000000004",
        cellId: "cell-loser",
        value: "Losing branch",
        parentId: "existing-parent",
      }), slot)

      expect(await draftRow(t, "draft-loser")).toMatchObject({
        status: "proposed",
        reviewed_at: null,
        reviewed_by: null,
      })
      const loserCell = await t.pg.query(
        `SELECT 1 FROM cells
          WHERE project_id = $1 AND file_id = $2 AND cell_id = 'cell-loser'
            AND side = 'target' AND target_lang = ''`,
        [PROJECT, FILE],
      )
      expect(loserCell.rows).toHaveLength(0)
      expect(await t.pg.query(`SELECT 1 FROM contextual_run_events`)).toMatchObject({ rows: [] })
    } finally {
      await t.close()
    }
  })

  it("does not let a malformed legacy event id roll back durable reconciliation", async () => {
    const t = await makeTestDb()
    try {
      await seedScope(t)
      await seedDraft(t, {
        id: "draft-legacy-envelope",
        cellId: "cell-legacy-envelope",
        text: "Accepted despite an old id shape",
      })

      await project(t, targetCommit({
        id: "legacy-short-id",
        cellId: "cell-legacy-envelope",
        value: "Accepted despite an old id shape",
      }))

      expect(await draftRow(t, "draft-legacy-envelope")).toMatchObject({
        status: "applied",
        reviewed_by: REVIEWER,
      })
      // Activity IDs promise UUIDv7. Preserve the cell/draft truth without
      // minting a misleading ID when an old envelope violates that contract.
      expect((await t.pg.query(`SELECT 1 FROM contextual_run_events`)).rows).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("does not let projection rebuild replay an old commit into a newer proposal", async () => {
    const t = await makeTestDb()
    try {
      await seedScope(t)
      const eventId = "0198a123-0000-7000-8000-000000000005"
      const cellId = "cell-newer-proposal"
      await t.pg.query(
        `INSERT INTO events
            (id, schema_version, project_id, file_id, cell_id, parent_id,
             kind, author, payload, client_ts, server_ts, server_seq)
         VALUES ($1, 1, $2, $3, $4, NULL, 'target.cell.commit', $5,
                 $6, $7, $8, 1)`,
        [
          eventId,
          PROJECT,
          FILE,
          cellId,
          REVIEWER,
          JSON.stringify({ value: "Historical cell value" }),
          COMMIT_TIME - 10,
          COMMIT_TIME,
        ],
      )
      await seedDraft(t, {
        id: "draft-created-after-history",
        cellId,
        text: "Historical cell value",
        createdAt: COMMIT_TIME + 60_000,
      })

      const response = await handleRebuildProjectionRequest(
        new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
          method: "POST",
          headers: { Authorization: "Bearer rebuild-secret" },
        }),
        { AQUILLA_PG: t.db, SYNC_SECRET_KEY: "rebuild-secret" },
      )
      expect(response?.status).toBe(200)

      const rebuilt = await t.pg.query<{ event_id: string; value: string }>(
        `SELECT event_id, value FROM cells
          WHERE project_id = $1 AND file_id = $2 AND cell_id = $3
            AND side = 'target' AND target_lang = ''`,
        [PROJECT, FILE, cellId],
      )
      expect(rebuilt.rows[0]).toEqual({ event_id: eventId, value: "Historical cell value" })
      expect(await draftRow(t, "draft-created-after-history")).toMatchObject({
        status: "proposed",
        reviewed_at: null,
        reviewed_by: null,
      })
      expect((await t.pg.query(`SELECT 1 FROM contextual_run_events`)).rows).toEqual([])
    } finally {
      await t.close()
    }
  })
})
