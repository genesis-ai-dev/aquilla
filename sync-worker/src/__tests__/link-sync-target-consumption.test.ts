// AQU-477: mirror sync — consumes='target' (the chain case).
//
// Covers the acceptance criteria on the issue:
//   - merge: structural fields from upstream's SOURCE row, text from
//     upstream's TARGET row (timed VTT cell keeps startMs/endMs + cast label)
//   - gate='validated' (default): a draft commit over a validated cell
//     mirrors nothing until the new head is validated again
//   - gate='head': every commit mirrors immediately
//   - validating a changed translation mirrors the new text and flags the
//     downstream's committed target as direct-stale
//   - an upstream cell never translated produces no downstream row at all

import { describe, it, expect } from "vitest"
import { mirrorSync, laneRelevantHeadSeq, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-upstream-b" // e.g. "French" in the English->French->Chaluba chain
const DOWNSTREAM = "proj-downstream-c" // e.g. "Chaluba"
const FILE = "file-episode-1"
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)

async function seedUpstreamProject(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'French', 1)`, [UPSTREAM])
}

async function seedDownstreamProject(
  t: TestDb,
  opts: { gate?: "head" | "validated"; cursor?: number },
): Promise<void> {
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor)
     VALUES ($1, 'Chaluba', 1, $2, 'live', 'target', $3, $4)`,
    [DOWNSTREAM, UPSTREAM, opts.gate ?? "validated", opts.cursor ?? 0],
  )
}

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-tc-${_seq}`
}

async function nextUpstreamSeq(t: TestDb): Promise<number> {
  const row = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  return Number(row.rows[0]?.next_seq ?? 1)
}

/** Apply one upstream event through the front-door projection (production
 *  path) with a real allocated server_seq. */
async function emitUpstream(
  t: TestDb,
  kind:
    | "file.create"
    | "source.cell.create"
    | "source.cell.commit"
    | "target.cell.commit"
    | "cell.validate"
    | "cell.unvalidate"
    | "cast.assign",
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown>; author?: string },
): Promise<{ id: string; seq: number }> {
  const id = nextId()
  const seq = await nextUpstreamSeq(t)
  // Monotonically increasing ts (not hardcoded to 1): cell.validate's
  // projection guards re-decisions with `WHERE excluded.decided_ts >
  // cell_validators.decided_ts` (event-projection.ts) — a second validate
  // by the SAME reviewer (re-validating after a re-translate) needs a
  // strictly later ts or the upsert silently no-ops, which several tests
  // below rely on NOT happening.
  const ts = seq
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, $6, $7, $8, $8, $9)`,
    [id, UPSTREAM, args.fileId ?? null, args.cellId ?? null, kind, args.author ?? "translator-b", JSON.stringify(args.payload), ts, seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId: null,
    kind,
    author: args.author ?? "translator-b",
    payload: args.payload,
    clientTs: ts,
    serverTs: ts,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return { id, seq }
}

/** French source.cell.create + target.cell.commit + cell.validate — the
 *  common "seed a validated translated timed cell" sequence used by several
 *  tests below. Returns the validate event's seq. */
async function seedValidatedFrenchCell(
  t: TestDb,
  cellId: string,
  opts: { sourceValue: string; targetValue: string; startMs: number; endMs: number; castName?: string },
): Promise<void> {
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId,
    payload: {
      cellId,
      value: opts.sourceValue,
      anchorCellId: null,
      startMs: opts.startMs,
      endMs: opts.endMs,
    },
  })
  if (opts.castName) {
    await emitUpstream(t, "cast.assign", { fileId: FILE, cellId, payload: { castName: opts.castName } })
  }
  const commit = await emitUpstream(t, "target.cell.commit", {
    fileId: FILE,
    cellId,
    payload: { value: opts.targetValue },
    author: "translator-b",
  })
  await emitUpstream(t, "cell.validate", {
    fileId: FILE,
    cellId,
    payload: { editEventId: commit.id },
    author: "reviewer-b",
  })
}

describe("mirrorSync — consumes='target' merge (the chain case)", () => {
  it("merges structure from upstream's SOURCE row with text from upstream's VALIDATED TARGET row, including timing + cast", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { gate: "validated" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Episode 1", fileType: "codex" } })
      await seedValidatedFrenchCell(t, "cell-1", {
        sourceValue: "In the beginning",
        targetValue: "Au commencement",
        startMs: 1000,
        endMs: 2500,
        castName: "Narrator",
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)

      const row = await t.pg.query<{
        value: string
        start_ms: string
        end_ms: string
        metadata: Record<string, unknown> | null
      }>(
        `SELECT value, start_ms, end_ms, metadata FROM cells
         WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      // Text came from the upstream TARGET row (French translation)...
      expect(row.rows[0]?.value).toBe("Au commencement")
      // ...while structure (timing + cast) came from the upstream SOURCE row.
      expect(Number(row.rows[0]?.start_ms)).toBe(1000)
      expect(Number(row.rows[0]?.end_ms)).toBe(2500)
      expect((row.rows[0]?.metadata as { cast_name?: string } | null)?.cast_name).toBe("Narrator")
    } finally {
      await t.close()
    }
  })

  it("an upstream cell with no (gated) target commit yet produces NO downstream row", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { gate: "validated" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Episode 1", fileType: "codex" } })
      // French source cell exists, but has never been translated.
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-untranslated",
        payload: { cellId: "cell-untranslated", value: "Not yet translated", anchorCellId: null },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(0)

      const row = await t.pg.query(
        `SELECT 1 FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-untranslated"],
      )
      expect(row.rows).toHaveLength(0)
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — gate semantics", () => {
  it("gate='validated' (default): a draft commit over a validated cell mirrors NOTHING until the new head is validated", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { gate: "validated" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Episode 1", fileType: "codex" } })
      await seedValidatedFrenchCell(t, "cell-1", {
        sourceValue: "original",
        targetValue: "traduction v1",
        startMs: 0,
        endMs: 1000,
      })
      await mirrorSync(t.db, DOWNSTREAM)

      const before = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(before.rows[0]?.value).toBe("traduction v1")

      // French translator re-commits a draft over the validated cell — NOT
      // yet re-validated.
      await emitUpstream(t, "target.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "traduction v2 (draft, unreviewed)" },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      // The lane-relevant head DID move (a target.cell.commit is lane-
      // relevant even in gate=validated mode — the probe must not starve),
      // but nothing should mirror because the new head isn't validated.
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(0)

      const after = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(after.rows[0]?.value).toBe("traduction v1") // unchanged
    } finally {
      await t.close()
    }
  })

  it("gate='validated': once the new draft IS validated, C's mirrored source advances", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { gate: "validated" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Episode 1", fileType: "codex" } })
      await seedValidatedFrenchCell(t, "cell-1", {
        sourceValue: "original",
        targetValue: "traduction v1",
        startMs: 0,
        endMs: 1000,
      })
      await mirrorSync(t.db, DOWNSTREAM)

      const commit2 = await emitUpstream(t, "target.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "traduction v2" },
      })
      await mirrorSync(t.db, DOWNSTREAM) // draft not validated yet: no-op

      await emitUpstream(t, "cell.validate", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { editEventId: commit2.id },
        author: "reviewer-b",
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)

      const row = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(row.rows[0]?.value).toBe("traduction v2")
    } finally {
      await t.close()
    }
  })

  it("gate='head': C's source advances on every upstream commit, validated or not", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { gate: "head" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Episode 1", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "original", anchorCellId: null },
      })
      await emitUpstream(t, "target.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "draft translation" },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)

      const row = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      // No validation ever happened — gate='head' mirrors it anyway.
      expect(row.rows[0]?.value).toBe("draft translation")
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — consumes='target' staleness propagation", () => {
  it("B validates a changed translation -> C's mirrored source updates and C's committed target flags direct-stale", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await seedDownstreamProject(t, { gate: "validated" })
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Episode 1", fileType: "codex" } })
      await seedValidatedFrenchCell(t, "cell-1", {
        sourceValue: "original",
        targetValue: "traduction v1",
        startMs: 0,
        endMs: 1000,
      })
      await mirrorSync(t.db, DOWNSTREAM)

      // Chaluba translator commits a target pinned to the current mirrored source head.
      const localSourceHead = await t.pg.query<{ event_id: string }>(
        `SELECT event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      const sourceEventId = localSourceHead.rows[0]?.event_id
      const targetCommit: PersistedEvent = {
        id: nextId(),
        schemaVersion: 1,
        projectId: DOWNSTREAM,
        fileId: DOWNSTREAM_FILE,
        cellId: "cell-1",
        parentId: null,
        kind: "target.cell.commit",
        author: "translator-chaluba",
        payload: { value: "Chaluba v1", sourceEventId },
        clientTs: 1,
        serverTs: 1,
        serverSeq: 1,
      }
      const stmts: AquillaStatement[] = []
      buildEventProjectionStmts(t.db, targetCommit, stmts)
      await t.db.batch(stmts)

      // French re-translates + validates.
      const commit2 = await emitUpstream(t, "target.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "traduction v2" },
      })
      await emitUpstream(t, "cell.validate", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { editEventId: commit2.id },
        author: "reviewer-b",
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)

      const updatedSource = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE, "cell-1"],
      )
      expect(updatedSource.rows[0]?.value).toBe("traduction v2")

      const staleCheck = await t.pg.query<{ cell_id: string }>(
        `SELECT t.cell_id FROM cells t JOIN cells s
           ON s.project_id = t.project_id AND s.cell_id = t.cell_id AND s.side = 'source'
         WHERE t.project_id = $1 AND t.file_id = $2 AND t.side = 'target'
           AND t.source_event_id IS NOT NULL AND s.event_id != t.source_event_id`,
        [DOWNSTREAM, DOWNSTREAM_FILE],
      )
      expect(staleCheck.rows.map((r) => r.cell_id)).toContain("cell-1")
    } finally {
      await t.close()
    }
  })
})

describe("laneRelevantHeadSeq — consumes='target' lane set", () => {
  it("counts target.cell.commit and cell.validate on top of the structural set", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamProject(t)
      await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "Episode 1", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { cellId: "cell-1", value: "original", anchorCellId: null },
      })
      const beforeSource = await laneRelevantHeadSeq(t.db, UPSTREAM, "source")
      const beforeTarget = await laneRelevantHeadSeq(t.db, UPSTREAM, "target")
      expect(beforeSource).toBe(beforeTarget) // no target-lane events yet

      await emitUpstream(t, "target.cell.commit", { fileId: FILE, cellId: "cell-1", payload: { value: "draft" } })

      const afterSource = await laneRelevantHeadSeq(t.db, UPSTREAM, "source")
      const afterTarget = await laneRelevantHeadSeq(t.db, UPSTREAM, "target")
      // consumes='source' probe must NOT move on a target-only event...
      expect(afterSource).toBe(beforeSource)
      // ...but consumes='target' probe must.
      expect(afterTarget).toBeGreaterThan(beforeTarget)
    } finally {
      await t.close()
    }
  })
})
