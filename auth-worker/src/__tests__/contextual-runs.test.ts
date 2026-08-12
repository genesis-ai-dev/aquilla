// Contextual run store (db/shared/contextual-runs.ts, design §8 slice D1).
// WHY these tests: the run engine's correctness rests on (1) exactly one
// active run per (project, file, lane), (2) status transitions that CANNOT be
// won by both sides of a race (guarded UPDATEs), and (3) staged drafts whose
// partial-UNIQUE "one live proposal per cell" invariant survives re-proposes.
// Each test targets a specific way one of those guarantees could fail open.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { PostgresDb, type PgExecutor } from "../../../db/shim/postgres"
import {
  createRun,
  getRun,
  listRuns,
  getActiveRun,
  requestPause,
  confirmPause,
  resumeRun,
  terminateRun,
  parkRun,
  failRun,
  setSpanCursor,
  recordSpanOutcome,
  appendSteering,
  readUnconsumedSteering,
  markSteeringConsumed,
  insertDrafts,
  listDrafts,
  listDraftsByRun,
  findProposedCellsFromOtherRuns,
  reviewDraft,
  countDrafts,
  getProjectAutopilotSummary,
  appendContextualRunEvent,
  listContextualRunEvents,
  tryAcquireContextualProjectLease,
  renewContextualProjectLease,
  releaseContextualProjectLease,
  STEERING_MAX_BYTES,
  type ContextualRunEventDetails,
  type SpanCursor,
} from "../../../db/shared/contextual-runs"

const db = env.AQUILLA_PG
const PROJECT = "proj-ctx"
const FILE = "file-mrk"

const seed = (n: number) => ({
  id: `${FILE}#s${n}`,
  fileId: FILE,
  anchorCellId: `c${n}`,
  startCellId: `c${n}`,
  endCellId: `c${n + 1}`,
  seedSource: "chunk",
})

async function newRun(over: { fileId?: string; targetLang?: string } = {}) {
  const r = await createRun(db, {
    projectId: PROJECT,
    fileId: over.fileId ?? FILE,
    targetLang: over.targetLang ?? "",
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 400 },
  })
  expect(r.status).toBe("ok")
  if (r.status !== "ok") throw new Error("unreachable")
  return r.run
}

async function seedTargetCell(
  cellId: string,
  value: string,
  targetLang = "",
): Promise<void> {
  await db.prepare(
    `INSERT INTO cells
        (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
     VALUES (?, ?, ?, 'target', ?, ?, ?, 0)`,
  ).bind(
    PROJECT,
    FILE,
    cellId,
    targetLang,
    value,
    `ev-${cellId}-${targetLang || "default"}`,
  ).run()
}

describe("run creation — one active run per (project, file, lane)", () => {
  it("refuses a second active run; a different lane or a terminated run frees the slot", async () => {
    const run = await newRun()
    expect(run.status).toBe("running")

    // Same lane → refused, pointing at the existing run.
    const dup = await createRun(db, { projectId: PROJECT, fileId: FILE })
    expect(dup).toEqual({ status: "active_exists", runId: run.id })

    // Refusal covers EVERY active status, not just running.
    await requestPause(db, run.id)
    expect((await createRun(db, { projectId: PROJECT, fileId: FILE })).status).toBe("active_exists")

    // A different lane is a different slot.
    const otherLane = await createRun(db, { projectId: PROJECT, fileId: FILE, targetLang: "fr" })
    expect(otherLane.status).toBe("ok")

    // Terminating the first frees its lane.
    await terminateRun(db, run.id)
    const again = await createRun(db, { projectId: PROJECT, fileId: FILE })
    expect(again.status).toBe("ok")
  })

  it("getActiveRun / listRuns surface the right rows", async () => {
    const run = await newRun()
    expect((await getActiveRun(db, PROJECT, FILE))?.id).toBe(run.id)
    expect(await getActiveRun(db, PROJECT, "other-file")).toBeNull()
    await terminateRun(db, run.id)
    expect(await getActiveRun(db, PROJECT, FILE)).toBeNull()
    // Terminated runs still list (history).
    expect((await listRuns(db, PROJECT, { fileId: FILE })).runs.map((r) => r.id)).toContain(run.id)
  })

  it("bounds newest-first history and attributes review drafts to their owning run", async () => {
    const older = await newRun()
    await insertDrafts(db, {
      runId: older.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "older-review-cell", text: "older review draft" }],
    })
    await terminateRun(db, older.id)
    const newer = await newRun()
    await db.prepare("UPDATE contextual_runs SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?")
      .bind(older.id)
      .run()
    await db.prepare("UPDATE contextual_runs SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?")
      .bind(newer.id)
      .run()

    const firstPage = await listRuns(db, PROJECT, { limit: 1 })
    expect(firstPage.runs.map((run) => [run.id, run.proposedDrafts])).toEqual([[newer.id, 0]])
    expect(firstPage.truncated).toBe(true)
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = await listRuns(db, PROJECT, {
      limit: 1,
      before: firstPage.nextCursor ?? undefined,
    })
    expect(secondPage.runs.map((run) => [run.id, run.proposedDrafts])).toEqual([[older.id, 1]])
    expect(secondPage.truncated).toBe(false)
  })
})

describe("cross-isolate project capacity leases", () => {
  it("atomically refuses a second worker over the weighted cap and reclaims stale capacity", async () => {
    await db.prepare(
      `INSERT INTO projects (id, name, created_by)
       VALUES (?, 'Lease project', 1) ON CONFLICT (id) DO NOTHING`,
    ).bind(PROJECT).run()
    const first = await newRun({ fileId: "lease-file-one" })
    const second = await newRun({ fileId: "lease-file-two" })

    // These calls represent independent Worker isolates: neither shares the
    // route module's in-memory semaphore, so Postgres is the sole authority.
    const leaseOne = await tryAcquireContextualProjectLease(db, {
      projectId: PROJECT,
      runId: first.id,
      weight: 3,
      limit: 4,
    })
    expect(leaseOne).not.toBeNull()
    expect(await tryAcquireContextualProjectLease(db, {
      projectId: PROJECT,
      runId: second.id,
      weight: 2,
      limit: 4,
    })).toBeNull()

    // An evicted Worker cannot run finally; expiry is the durable recovery
    // path, and acquisition deletes that stale lease under the project lock.
    await db.prepare(
      "UPDATE contextual_project_leases SET expires_at = now() - interval '1 second' WHERE id = ?",
    ).bind(leaseOne?.id).run()
    const leaseTwo = await tryAcquireContextualProjectLease(db, {
      projectId: PROJECT,
      runId: second.id,
      weight: 2,
      limit: 4,
    })
    expect(leaseTwo).not.toBeNull()
    if (!leaseTwo) throw new Error("stale capacity was not reclaimed")
    expect(await renewContextualProjectLease(db, leaseTwo)).toBe(true)
    await releaseContextualProjectLease(db, leaseTwo)
    const remaining = await db.prepare(
      "SELECT COUNT(*) AS count FROM contextual_project_leases WHERE project_id = ?",
    ).bind(PROJECT).first<{ count: number }>()
    expect(Number(remaining?.count ?? -1)).toBe(0)
  })
})

describe("guarded transitions", () => {
  it("pausing→paused only from pausing — the pause race has exactly one winner", async () => {
    const run = await newRun()

    // confirmPause on a RUNNING run must refuse (the executor may only
    // acknowledge a pause a user actually requested).
    const early = await confirmPause(db, run.id)
    expect(early).toEqual({ status: "invalid_state", current: "running" })

    const requested = await requestPause(db, run.id)
    expect(requested.status).toBe("ok")

    // Racing double-request: the second pause finds 'pausing', not 'running'.
    const second = await requestPause(db, run.id)
    expect(second).toEqual({ status: "invalid_state", current: "pausing" })

    const confirmed = await confirmPause(db, run.id)
    expect(confirmed.status).toBe("ok")
    if (confirmed.status === "ok") expect(confirmed.run.status).toBe("paused")

    // And the executor cannot double-confirm.
    expect((await confirmPause(db, run.id)).status).toBe("invalid_state")
  })

  it("resume works from paused AND parked; terminate is terminal; failed records the error", async () => {
    const run = await newRun()
    await requestPause(db, run.id)
    await confirmPause(db, run.id)
    const resumed = await resumeRun(db, run.id)
    expect(resumed.status).toBe("ok")

    const parked = await parkRun(db, run.id)
    expect(parked.status).toBe("ok")
    const woken = await resumeRun(db, run.id)
    expect(woken.status).toBe("ok")

    const failed = await failRun(db, run.id, "llm\nexploded\u0000")
    expect(failed.status).toBe("ok")
    expect((await getRun(db, run.id))?.lastError).toBe("llm exploded")

    // failed is terminal: no resume, no terminate, no pause.
    expect((await resumeRun(db, run.id)).status).toBe("invalid_state")
    expect((await terminateRun(db, run.id)).status).toBe("invalid_state")
    expect((await requestPause(db, run.id)).status).toBe("invalid_state")

    expect((await resumeRun(db, "no-such-run")).status).toBe("not_found")
  })
})

describe("span cursor + outcome accounting", () => {
  it("recordSpanOutcome advances the cursor and counters in one batch", async () => {
    const run = await newRun()
    const cursor: SpanCursor = { seeds: [seed(1), seed(3)], nextIndex: 0 }
    const set = await setSpanCursor(db, run.id, cursor)
    expect(set?.totalSpans).toBe(2)
    expect(set?.spanCursor?.nextIndex).toBe(0)

    const afterDone = await recordSpanOutcome(db, run.id, {
      cursor: { ...cursor, nextIndex: 1 },
      outcome: "done",
      unitsUsed: 12,
      callsUsed: 4,
      steeringCursor: new Date().toISOString(),
    })
    expect(afterDone?.doneSpans).toBe(1)
    expect(afterDone?.failedSpans).toBe(0)
    expect(afterDone?.unitsSpent).toBe(12)
    expect(afterDone?.callsSpent).toBe(4)
    expect(afterDone?.spanCursor?.nextIndex).toBe(1)
    expect(afterDone?.steeringCursor).not.toBeNull()

    const afterFail = await recordSpanOutcome(db, run.id, {
      cursor: { ...cursor, nextIndex: 2 },
      outcome: "failed",
      unitsUsed: 5,
      callsUsed: 1,
      lastError: "password=hunter2",
    })
    expect(afterFail?.doneSpans).toBe(1)
    expect(afterFail?.failedSpans).toBe(1)
    expect(afterFail?.unitsSpent).toBe(17)
    expect(afterFail?.lastError).toMatch(/redacted/i)
    expect(afterFail?.lastError).not.toContain("hunter2")
  })
})

describe("durable sanitized activity", () => {
  it("passes run cursor/role and draft evidence as structured JSON at the production adapter boundary", async () => {
    let roleParam: unknown
    let cursorParam: unknown
    let verdictParam: unknown
    let provenanceParam: unknown
    let runRow: Record<string, unknown> | null = null
    let draftId = ""
    const executor: PgExecutor = {
      async run(sql, params) {
        if (sql.includes("SELECT id FROM contextual_runs")) return { rows: [], rowCount: 0 }
        if (sql.includes("INSERT INTO contextual_runs")) {
          roleParam = params[5]
          runRow = {
            id: params[0], project_id: params[1], file_id: params[2], target_lang: params[3],
            status: "running", initiated_by: params[4], role_snapshot: params[5], span_cursor: null,
            done_spans: 0, total_spans: 0, failed_spans: 0, units_spent: 0, calls_spent: 0,
            last_error: null, steering_cursor: null, anchor_cell_id: params[6], scope_group: params[7],
            created_at: "2026-08-11T00:00:00.000Z", updated_at: "2026-08-11T00:00:00.000Z",
          }
          return { rows: [runRow], rowCount: 1 }
        }
        if (sql.includes("UPDATE contextual_runs") && sql.includes("SET span_cursor")) {
          cursorParam = params[0]
          runRow = { ...runRow, span_cursor: params[0], total_spans: params[1] }
          return { rows: [runRow as Record<string, unknown>], rowCount: 1 }
        }
        if (sql.includes("UPDATE contextual_drafts")) return { rows: [], rowCount: 0 }
        if (sql.includes("INSERT INTO contextual_drafts")) {
          draftId = String(params[0])
          verdictParam = params[7]
          provenanceParam = params[8]
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes("SELECT id, run_id") && sql.includes("FROM contextual_drafts")) {
          return {
            rows: [{
              id: draftId, run_id: (runRow as Record<string, unknown>).id,
              project_id: PROJECT, file_id: FILE, cell_id: "c-json", scene_brief_id: null,
              text: "structured", verdicts: verdictParam, provenance: provenanceParam,
              status: "proposed", created_at: "2026-08-11T00:00:00.000Z",
              reviewed_at: null, reviewed_by: null,
            }],
            rowCount: 1,
          }
        }
        throw new Error(`unexpected adapter SQL: ${sql}`)
      },
      begin: (fn) => fn(executor),
    }
    const adapterDb = new PostgresDb(executor)
    const created = await createRun(adapterDb, {
      projectId: PROJECT,
      fileId: FILE,
      roleSnapshot: { userId: 7, username: "adapter", level: 400 },
    })
    if (created.status !== "ok") throw new Error("run not created")
    const cursor: SpanCursor = { seeds: [seed(1)], nextIndex: 0 }
    await setSpanCursor(adapterDb, created.run.id, cursor)
    const drafts = await insertDrafts(adapterDb, {
      runId: created.run.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{
        cellId: "c-json",
        text: "structured",
        verdicts: { ambiguity: "approved" },
        provenance: { spanId: "span-json", exampleIds: ["e1"] },
      }],
    })

    expect(roleParam).toEqual({ userId: 7, username: "adapter", level: 400 })
    expect(cursorParam).toEqual(cursor)
    expect(verdictParam).toEqual({ ambiguity: "approved" })
    expect(provenanceParam).toEqual({ spanId: "span-json", exampleIds: ["e1"] })
    expect(drafts[0]).toMatchObject({
      verdicts: verdictParam,
      provenance: provenanceParam,
    })
  })

  it("passes details as structured JSON at the production Postgres adapter boundary", async () => {
    let adapterDetails: unknown
    const executor: PgExecutor = {
      async run(_sql, params) {
        adapterDetails = params[10]
        return {
          rows: [{
            id: params[0],
            run_id: params[1],
            project_id: params[2],
            file_id: params[3],
            kind: params[4],
            span_id: params[5],
            span_label: params[6],
            status: params[7],
            phase: params[8],
            summary: params[9],
            details: params[10],
            created_at: "2026-08-11T00:00:00.000Z",
          }],
          rowCount: 1,
        }
      },
      begin: (fn) => fn(executor),
    }

    const adapterDb = new PostgresDb(executor)
    const event = await appendContextualRunEvent(adapterDb, {
      runId: "run-adapter-boundary",
      projectId: PROJECT,
      fileId: FILE,
      kind: "drafts_staged",
      status: "complete",
      details: { count: 2, cellIds: ["c1", "c2"] },
    })

    // postgres.js infers the cast parameter as jsonb and JSON-serializes it.
    // A pre-stringified value is therefore encoded twice and reaches Postgres
    // as a jsonb string, violating contextual_run_events_details_check.
    expect(adapterDetails).toEqual({ count: 2, cellIds: ["c1", "c2"] })
    expect(typeof adapterDetails).toBe("object")
    expect(event.details).toEqual(adapterDetails)
  })

  it("keeps superseded draft evidence first-class through the typed sanitizer", async () => {
    const run = await newRun()
    const event = await appendContextualRunEvent(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      kind: "draft_reviewed",
      status: "superseded",
      details: {
        draftId: "draft-old",
        cellId: "cell-1",
        outcome: "superseded",
      },
    })

    expect(event).toMatchObject({
      status: "superseded",
      summary: "Draft superseded",
      details: {
        draftId: "draft-old",
        cellId: "cell-1",
        outcome: "superseded",
      },
    })
  })

  it("drops unapproved prose/token keys, bounds cell ids, and returns the latest ordered tail", async () => {
    const run = await newRun()
    const cellIds = Array.from({ length: 140 }, (_, i) => `cell-${i}`)
    const maliciousDetails = {
      count: 140,
      cellIds,
      promptText: "full private prompt",
      draftText: "a model-generated draft",
      reasoning: "hidden chain of thought",
      completionTokens: 999,
    } as ContextualRunEventDetails
    const first = await appendContextualRunEvent(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      kind: "drafts_staged",
      status: "complete",
      details: maliciousDetails,
    })
    expect(first.details.count).toBe(140)
    expect(first.details.cellIds).toHaveLength(100)
    expect(first.details.truncated).toBe(true)
    expect(Object.keys(first.details).sort()).toEqual(["cellIds", "count", "truncated"])
    expect(JSON.stringify(first)).not.toMatch(/private prompt|model-generated|reasoning|Tokens/)

    const second = await appendContextualRunEvent(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      kind: "run_state",
      status: "parked",
      details: { done: 2, total: 2, failed: 0 },
    })
    expect(second.summary).toBe("Autopilot is idle")
    const queued = await appendContextualRunEvent(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      kind: "run_state",
      status: "parked",
      details: { done: 2, total: 5, failed: 0 },
    })
    expect(queued.summary).toBe("Autopilot has work queued")
    // Explicit timestamps make the latest-tail assertion independent of two
    // uuidv7s generated within the same millisecond.
    await db.prepare("UPDATE contextual_run_events SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?")
      .bind(first.id)
      .run()
    await db.prepare("UPDATE contextual_run_events SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?")
      .bind(second.id)
      .run()
    await db.prepare("UPDATE contextual_run_events SET created_at = '2026-01-03T00:00:00Z' WHERE id = ?")
      .bind(queued.id)
      .run()
    const tail = await listContextualRunEvents(db, { projectId: PROJECT, runId: run.id, limit: 1 })
    expect(tail.truncated).toBe(true)
    expect(tail.events.map((event) => event.id)).toEqual([queued.id])
    expect((await listContextualRunEvents(db, { projectId: "other", runId: run.id })).events).toEqual([])
  })
})

describe("steering inbox", () => {
  it("append → read-unconsumed (scoped) → markConsumed", async () => {
    const run = await newRun()
    const projWide = await appendSteering(db, { projectId: PROJECT, kind: "direction", body: "keep it plain" })
    const fileScoped = await appendSteering(db, { projectId: PROJECT, fileId: FILE, kind: "note", body: "fyi" })
    const otherFile = await appendSteering(db, { projectId: PROJECT, fileId: "file-other", kind: "direction", body: "not for us" })
    const otherRun = await appendSteering(db, { projectId: PROJECT, runId: "some-other-run", kind: "direction", body: "not our run" })
    expect([projWide.status, fileScoped.status, otherFile.status, otherRun.status]).toEqual(["ok", "ok", "ok", "ok"])

    const visible = await readUnconsumedSteering(db, { projectId: PROJECT, fileId: FILE, runId: run.id })
    expect(visible.map((s) => s.body)).toEqual(["keep it plain", "fyi"])

    await markSteeringConsumed(db, visible.map((s) => s.id))
    expect(await readUnconsumedSteering(db, { projectId: PROJECT, fileId: FILE, runId: run.id })).toEqual([])
    // The other-file entry stays unconsumed for ITS run.
    const others = await readUnconsumedSteering(db, { projectId: PROJECT, fileId: "file-other", runId: run.id })
    expect(others.map((s) => s.body)).toEqual(["not for us"])
  })

  it("enforces the 10KB body cap and the secret scan", async () => {
    const big = await appendSteering(db, { projectId: PROJECT, kind: "direction", body: "x".repeat(STEERING_MAX_BYTES + 1) })
    expect(big.status).toBe("validation_failed")
    const secret = await appendSteering(db, { projectId: PROJECT, kind: "direction", body: "use token=aqk_abc123" })
    expect(secret.status).toBe("validation_failed")
    const empty = await appendSteering(db, { projectId: PROJECT, kind: "note", body: "   " })
    expect(empty.status).toBe("validation_failed")
  })
})

describe("staged drafts", () => {
  it("keeps legacy non-default proposals out of the actionable default-lane queue", async () => {
    const defaultOwner = await newRun()
    await insertDrafts(db, {
      runId: defaultOwner.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "default-review", text: "default lane proposal" }],
    })
    await terminateRun(db, defaultOwner.id)

    // V1 cannot create these through the route/tick, but rows from an older
    // lane-aware prototype may still exist and must remain inspectable without
    // leaking into the editor's default-lane review mirror.
    const legacyFrenchOwner = await newRun({ targetLang: "fr" })
    await insertDrafts(db, {
      runId: legacyFrenchOwner.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "french-review", text: "proposition française" }],
    })
    await terminateRun(db, legacyFrenchOwner.id)

    const currentDefault = await newRun()
    expect((await listDrafts(db, PROJECT, FILE, "proposed")).map((draft) => draft.cellId))
      .toEqual(["default-review"])
    expect(await countDrafts(db, PROJECT, FILE)).toMatchObject({ proposed: 1 })
    expect([
      ...(await findProposedCellsFromOtherRuns(db, {
        projectId: PROJECT,
        fileId: FILE,
        runId: currentDefault.id,
        targetLang: "",
      })),
    ]).toEqual(["default-review"])

    // Historic lane evidence remains available through its owning run.
    expect((await listDraftsByRun(db, PROJECT, legacyFrenchOwner.id)).map((draft) => draft.cellId))
      .toEqual(["french-review"])
    expect((await listRuns(db, PROJECT, { proposedOnly: true })).runs.map((run) => run.id))
      .toEqual([defaultOwner.id])
    const allRuns = await listRuns(db, PROJECT)
    expect(allRuns.runs.find((run) => run.id === legacyFrenchOwner.id)?.proposedDrafts).toBe(1)

    // The compact card count and its drill-down owners describe the same
    // actionable default-lane backlog.
    const overview = await getProjectAutopilotSummary(db, PROJECT)
    expect(overview.proposedDrafts).toBe(1)
    expect(overview.files.find((row) => row.runId === legacyFrenchOwner.id)?.proposedDrafts).toBe(0)
  })

  it("a re-propose supersedes the old proposed row in the same batch (partial UNIQUE holds)", async () => {
    const run = await newRun()
    const first = await insertDrafts(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      sceneBriefId: "sb-1",
      drafts: [
        { cellId: "c1", text: "draft v1 of c1" },
        { cellId: "c2", text: "draft v1 of c2" },
      ],
    })
    expect(first).toHaveLength(2)

    // Re-propose c1 only (e.g. a refresh_span re-run of the same span).
    const second = await insertDrafts(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      sceneBriefId: "sb-2",
      drafts: [{ cellId: "c1", text: "draft v2 of c1" }],
    })
    expect(second).toHaveLength(1)
    expect(second[0].text).toBe("draft v2 of c1")

    const all = await listDrafts(db, PROJECT, FILE)
    const byStatus = (s: string) => all.filter((d) => d.status === s)
    expect(byStatus("proposed").map((d) => d.text).sort()).toEqual(["draft v1 of c2", "draft v2 of c1"])
    expect(byStatus("superseded").map((d) => d.text)).toEqual(["draft v1 of c1"])

    const counts = await countDrafts(db, PROJECT, FILE)
    expect(counts).toEqual({ proposed: 2, applied: 0, rejected: 0, superseded: 1 })

    await db.prepare("UPDATE contextual_drafts SET created_at = '2026-01-01T00:00:00Z' WHERE run_id = ?")
      .bind(run.id)
      .run()
    await db.prepare("UPDATE contextual_drafts SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?")
      .bind(second[0].id)
      .run()
    expect((await listDraftsByRun(db, PROJECT, run.id, 1)).map((draft) => draft.id)).toEqual([
      second[0].id,
    ])
  })

  it("only acknowledges applied after the exact draft is current in its owning target lane", async () => {
    const defaultRun = await newRun()
    const initialDrafts = await insertDrafts(db, {
      runId: defaultRun.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [
        { cellId: "missing-target", text: "not projected yet" },
        { cellId: "mismatched-target", text: "the proposed wording" },
      ],
    })
    const missingTarget = initialDrafts.find((draft) => draft.cellId === "missing-target")
    const mismatchedTarget = initialDrafts.find((draft) => draft.cellId === "mismatched-target")
    if (!missingTarget || !mismatchedTarget) throw new Error("expected both review drafts")

    expect(await reviewDraft(db, { id: missingTarget.id, action: "applied" }))
      .toEqual({ status: "not_projected" })

    await seedTargetCell("mismatched-target", "a different human edit")
    expect(await reviewDraft(db, { id: mismatchedTarget.id, action: "applied" }))
      .toEqual({ status: "not_projected" })

    const frenchRun = await newRun({ targetLang: "fr" })
    const [laneOwnedDraft] = await insertDrafts(db, {
      runId: frenchRun.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "lane-owned", text: "proposition exacte" }],
    })
    await seedTargetCell("lane-owned", "proposition exacte", "")
    expect(await reviewDraft(db, { id: laneOwnedDraft.id, action: "applied" }))
      .toEqual({ status: "not_projected" })

    await seedTargetCell("lane-owned", "proposition exacte", "fr")
    const applied = await reviewDraft(db, {
      id: laneOwnedDraft.id,
      action: "applied",
      reviewedBy: "lead",
    })
    expect(applied.status).toBe("ok")
    if (applied.status === "ok") {
      expect(applied.draft.status).toBe("applied")
      expect(applied.draft.reviewedBy).toBe("lead")
      expect(applied.draft.reviewedAt).not.toBeNull()
    }

    const retry = await reviewDraft(db, {
      id: laneOwnedDraft.id,
      action: "applied",
      reviewedBy: "lead",
    })
    expect(retry.status).toBe("already")
    if (retry.status === "already") expect(retry.draft.status).toBe("applied")

    // A conflicting second decision still loses the guard.
    const again = await reviewDraft(db, { id: laneOwnedDraft.id, action: "rejected" })
    expect(again).toEqual({ status: "invalid_state", current: "applied" })
    expect((await reviewDraft(db, { id: "no-such", action: "applied" })).status).toBe("not_found")
  })

  it("still rejects a proposed draft without requiring a target projection", async () => {
    const run = await newRun()
    const [draft] = await insertDrafts(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "reject-without-target", text: "dismiss me" }],
    })

    const rejected = await reviewDraft(db, {
      id: draft.id,
      action: "rejected",
      reviewedBy: "lead",
    })
    expect(rejected.status).toBe("ok")
    if (rejected.status === "ok") {
      expect(rejected.draft.status).toBe("rejected")
      expect(rejected.draft.reviewedBy).toBe("lead")
      expect(rejected.draft.reviewedAt).not.toBeNull()
    }
  })
})
