// Wave execution, live streaming, and driver recovery (lib/contextual/tick.ts
// + db/shared/contextual-runs.ts). WHY: turning a chain of spans into a graph
// of waves moves three guarantees that used to be free, so each one is pinned
// here:
//
//   1. Coverage under concurrency — a wave must advance the cursor past
//      EXACTLY the spans it ran, and count them all, or a book silently loses
//      passages.
//   2. Isolation under concurrency — two spans staging the same cell must not
//      fail each other (serially impossible, so the old INSERT was bare), and
//      neither may stage over text a human typed while the wave was in flight.
//   3. Recovery — a run whose driver died must be adoptable. `resumeRun`
//      refuses a 'running' run, so before the sweeper a dead driver meant a
//      run that spun forever with no way back.
//
// Plus the ordering rule that makes the feature feel instant (work starts at
// the user's anchor) and the frames that make it legible while it runs.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  createRun,
  getRun,
  listDrafts,
  insertDrafts,
  findOccupiedCells,
  claimStrandedRuns,
  listAutopilotCandidateFiles,
  getProjectAutopilotSummary,
  parkRun,
  type StoredSpanSeed,
} from "../../../db/shared/contextual-runs"
import {
  runOneTick,
  makeLlmCall,
  waveSize,
  orderSeedsFromAnchor,
  MAX_WAVE_CONCURRENCY,
  type ContextualProgressFrame,
} from "../lib/contextual/tick"
import type { CellPair } from "../lib/agent/tools/select-cells"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"

const db = env.AQUILLA_PG
const PROJECT = "proj-wave"
const FILE = "file-wave"
const MOCK_URL = "http://mock.local/api/v1/chat/completions"

// ── Fetch stub (same real path as contextual-tick.test.ts) ──────────────────

const realFetch = globalThis.fetch
/** Optional hook fired when the drafter is called — lets a test mutate the
 *  database mid-span to simulate a human typing under a running wave. */
let onDraftCall: (() => Promise<void>) | null = null

beforeEach(() => {
  onDraftCall = null
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url !== MOCK_URL) throw new Error(`unexpected fetch in wave test: ${url}`)
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: { role: string; content: string }[]
    }
    const system = body.messages.find((m) => m.role === "system")?.content ?? ""
    if (system.includes("[[ctx:draft]]") && onDraftCall) await onDraftCall()
    return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
})

afterEach(() => {
  vi.stubGlobal("fetch", realFetch)
})

const llm = () =>
  makeLlmCall({
    url: MOCK_URL,
    apiKey: "mock",
    models: { fast: "mock/fast", mid: "mock/mid", deep: "mock/deep" },
  })

// ── Seeding ─────────────────────────────────────────────────────────────────

async function seedCell(
  cellId: string,
  ref: string,
  source: string,
  opts?: { fileId?: string; target?: string },
): Promise<void> {
  const fileId = opts?.fileId ?? FILE
  await db
    .prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
    .bind(PROJECT, fileId, cellId, source, ref, `ev-src-${fileId}-${cellId}`)
    .run()
  if (opts?.target !== undefined) {
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, source_event_id, last_edit_at, validated)
         VALUES (?, ?, ?, 'target', ?, ?, ?, ?, 0, 0)`,
      )
      .bind(PROJECT, fileId, cellId, opts.target, ref, `ev-tgt-${fileId}-${cellId}`, `ev-src-${fileId}-${cellId}`)
      .run()
  }
}

/** Four chapters → four derived spans, all untranslated. */
async function seedFourSpans(): Promise<void> {
  await seedCell("w1", "MRK 1:1", "In the beginning")
  await seedCell("w2", "MRK 2:1", "Some days later")
  await seedCell("w3", "MRK 3:1", "He went out again")
  await seedCell("w4", "MRK 4:1", "Again he began to teach")
}

async function startRun(anchorCellId?: string) {
  const created = await createRun(db, {
    projectId: PROJECT,
    fileId: FILE,
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 400 },
    ...(anchorCellId ? { anchorCellId } : {}),
  })
  if (created.status !== "ok") throw new Error("run not created")
  return created.run
}

// ── Wave sizing: a graph must not tax small work ────────────────────────────

describe("waveSize", () => {
  it("keeps small work strictly serial — fan-out overhead is the whole cost there", () => {
    expect(waveSize(0)).toBe(1)
    expect(waveSize(1)).toBe(1)
    expect(waveSize(4)).toBe(1)
    expect(waveSize(8)).toBe(1)
  })

  it("widens with the work and stops at the provider-rate ceiling", () => {
    expect(waveSize(9)).toBe(2)
    expect(waveSize(24)).toBe(3)
    expect(waveSize(106)).toBe(MAX_WAVE_CONCURRENCY)
  })

  it("never exceeds an explicitly lowered cap (project fan-out divides it)", () => {
    expect(waveSize(106, 2)).toBe(2)
    expect(waveSize(106, 1)).toBe(1)
  })
})

// ── Anchor ordering: same coverage, results where the user is looking ───────

describe("orderSeedsFromAnchor", () => {
  const pairs = ["a", "b", "c", "d", "e", "f"].map(
    (cellId, i) =>
      ({
        cellId,
        canonicalRef: null,
        sequenceIndex: i,
        anchorCellId: null,
        source: "",
        target: "",
        validated: false,
        aiDrafted: false,
        sourceHead: null,
        targetBasedOn: null,
        hasTargetRow: false,
      }) as CellPair,
  )
  const seed = (id: string, start: string, end: string): StoredSpanSeed => ({
    id,
    fileId: FILE,
    anchorCellId: start,
    startCellId: start,
    endCellId: end,
    seedSource: "chunk",
  })
  const seeds = [seed("s1", "a", "b"), seed("s2", "c", "d"), seed("s3", "e", "f")]

  it("rotates the span containing the anchor to the front, wrapping the rest", () => {
    const ordered = orderSeedsFromAnchor(seeds, "d", pairs)
    expect(ordered.map((s) => s.id)).toEqual(["s2", "s3", "s1"])
  })

  it("preserves coverage exactly — every seed still runs once", () => {
    const ordered = orderSeedsFromAnchor(seeds, "e", pairs)
    expect([...ordered].map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"])
  })

  it("leaves order alone when the anchor is unknown, absent, or already first", () => {
    expect(orderSeedsFromAnchor(seeds, "zzz", pairs)).toBe(seeds)
    expect(orderSeedsFromAnchor(seeds, null, pairs)).toBe(seeds)
    expect(orderSeedsFromAnchor(seeds, "a", pairs)).toBe(seeds)
  })
})

// ── The wave itself ─────────────────────────────────────────────────────────

describe("runOneTick as a wave", () => {
  it("runs several spans at once and advances the cursor past exactly those spans", async () => {
    await seedFourSpans()
    const run = await startRun()

    const result = await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 3 })

    const after = await getRun(db, run.id)
    expect(after?.spanCursor?.seeds).toHaveLength(4)
    expect(after?.spanCursor?.nextIndex).toBe(3) // exactly the wave's width
    expect(after?.doneSpans).toBe(3)
    expect(after?.failedSpans).toBe(0)
    expect(result.reports).toHaveLength(3)
    expect(result.continueRun).toBe(true) // the fourth span remains

    // Every span in the wave staged its own cell — no work lost to the race.
    const drafts = await listDrafts(db, PROJECT, FILE, "proposed")
    expect(drafts.map((d) => d.cellId).sort()).toEqual(["w1", "w2", "w3"])
  })

  it("does not overrun the end of the cursor when the wave is wider than the work", async () => {
    await seedFourSpans()
    const run = await startRun()

    const first = await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 10 })
    const after = await getRun(db, run.id)

    expect(after?.spanCursor?.nextIndex).toBe(4)
    expect(after?.doneSpans).toBe(4)
    // Cursor exhausted → parked, never left 'running' with nothing to do.
    expect(first.continueRun).toBe(false)
    expect(after?.status).toBe("parked")
  })

  it("starts the first wave at the user's anchor instead of the top of the file", async () => {
    await seedFourSpans()
    const run = await startRun("w3")

    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })

    // MRK 3 ran first even though it is third in document order.
    const drafts = await listDrafts(db, PROJECT, FILE, "proposed")
    expect(drafts.map((d) => d.cellId)).toEqual(["w3"])
    const after = await getRun(db, run.id)
    expect(after?.spanCursor?.seeds[0].startCellId).toBe("w3")
  })

  it("streams a lane-open, phase, and draft frame for every span in the wave", async () => {
    await seedFourSpans()
    const run = await startRun()
    const frames: ContextualProgressFrame[] = []

    await runOneTick({
      db,
      runId: run.id,
      llm: llm(),
      concurrency: 2,
      notify: async (f) => {
        frames.push(f)
      },
    })

    const starts = frames.filter((f) => f.type === "contextual.span.start")
    expect(starts).toHaveLength(2)
    expect(new Set(starts.map((f) => (f as { spanId: string }).spanId)).size).toBe(2)

    // The lane opens BEFORE any model output for that span — that is the whole
    // point of the frame (the closure loop is the slowest phase).
    const firstStartIdx = frames.findIndex((f) => f.type === "contextual.span.start")
    const firstSceneIdx = frames.findIndex((f) => f.type === "contextual.scene")
    expect(firstStartIdx).toBeLessThan(firstSceneIdx)

    const phases = frames.filter((f) => f.type === "contextual.phase")
    expect(phases.map((f) => (f as { phase: string }).phase)).toContain("reading")
    expect(phases.map((f) => (f as { phase: string }).phase)).toContain("drafting")

    // The payload users are actually waiting for: verified text, per span.
    const drafts = frames.filter((f) => f.type === "contextual.drafts")
    expect(drafts).toHaveLength(2)
    const payload = drafts[0] as { drafts: { cellId: string; text: string; draftId: string }[] }
    expect(payload.drafts).toHaveLength(1)
    expect(payload.drafts[0].text).toMatch(/^MOCK /)
    expect(payload.drafts[0].draftId).toBeTruthy()
  })

  it("does not stage over a cell a human filled in while the span was running", async () => {
    await seedFourSpans()
    const run = await startRun()

    // Simulate a translator typing into w1 after the wave snapshotted pairs.
    onDraftCall = async () => {
      onDraftCall = null
      await db
        .prepare(
          `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, source_event_id, last_edit_at, validated)
           VALUES (?, ?, 'w1', 'target', 'human wrote this', 'MRK 1:1', 'ev-tgt-human', 'ev-src-file-wave-w1', 0, 0)`,
        )
        .bind(PROJECT, FILE)
        .run()
    }

    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })

    // The draft was produced but deliberately not staged — a proposal stacked
    // on fresh human work is noise the translator has to dismiss.
    const drafts = await listDrafts(db, PROJECT, FILE, "proposed")
    expect(drafts.map((d) => d.cellId)).not.toContain("w1")
  })
})

// ── Isolation primitives ────────────────────────────────────────────────────

describe("draft staging under concurrency", () => {
  it("supersedes rather than throwing when two spans stage the same cell", async () => {
    await seedFourSpans()
    const base = {
      runId: "run-a",
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "w1", text: "first" }],
    }
    await insertDrafts(db, base)
    // A second span (or a replayed wave) proposing the same cell must not hit
    // the partial UNIQUE — serially this was impossible, concurrently it is not.
    await expect(
      insertDrafts(db, { ...base, runId: "run-b", drafts: [{ cellId: "w1", text: "second" }] }),
    ).resolves.toBeTruthy()

    const live = await listDrafts(db, PROJECT, FILE, "proposed")
    expect(live).toHaveLength(1)
    expect(live[0].text).toBe("second")
  })

  it("findOccupiedCells reports only cells that currently hold target text", async () => {
    await seedCell("occ1", "LUK 1:1", "source one", { target: "already translated" })
    await seedCell("occ2", "LUK 1:2", "source two")
    await seedCell("occ3", "LUK 1:3", "source three", { target: "" })

    const occupied = await findOccupiedCells(db, {
      projectId: PROJECT,
      fileId: FILE,
      cellIds: ["occ1", "occ2", "occ3"],
    })
    expect([...occupied]).toEqual(["occ1"])
  })

  it("findOccupiedCells short-circuits on an empty list", async () => {
    const occupied = await findOccupiedCells(db, { projectId: PROJECT, fileId: FILE, cellIds: [] })
    expect(occupied.size).toBe(0)
  })
})

// ── Driver recovery ─────────────────────────────────────────────────────────

describe("claimStrandedRuns", () => {
  it("adopts a 'running' run whose driver stopped heartbeating", async () => {
    await seedFourSpans()
    const run = await startRun()
    await db
      .prepare(`UPDATE contextual_runs SET updated_at = now() - interval '1 hour' WHERE id = ?`)
      .bind(run.id)
      .run()

    const adopted = await claimStrandedRuns(db, 10)
    expect(adopted.map((r) => r.id)).toContain(run.id)
    // Claiming refreshes the heartbeat, so a second sweeper cannot double-drive.
    expect((await claimStrandedRuns(db, 10)).map((r) => r.id)).not.toContain(run.id)
  })

  it("leaves a run with a live heartbeat alone", async () => {
    await seedFourSpans()
    const run = await startRun()
    const adopted = await claimStrandedRuns(db, 10)
    expect(adopted.map((r) => r.id)).not.toContain(run.id)
  })

  it("wakes a run that parked with spans still queued (the loop's wave cap)", async () => {
    await seedFourSpans()
    const run = await startRun()
    // Give it a cursor with work left, then park it and age the heartbeat.
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })
    await parkRun(db, run.id)
    await db
      .prepare(`UPDATE contextual_runs SET updated_at = now() - interval '1 hour' WHERE id = ?`)
      .bind(run.id)
      .run()

    const adopted = await claimStrandedRuns(db, 10)
    expect(adopted.map((r) => r.id)).toContain(run.id)
    expect(adopted.find((r) => r.id === run.id)?.status).toBe("running")
  })

  it("leaves a parked run with an exhausted cursor alone — it has nothing to do", async () => {
    await seedFourSpans()
    const run = await startRun()
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 10 }) // runs everything, parks
    await db
      .prepare(`UPDATE contextual_runs SET updated_at = now() - interval '1 hour' WHERE id = ?`)
      .bind(run.id)
      .run()

    const adopted = await claimStrandedRuns(db, 10)
    expect(adopted.map((r) => r.id)).not.toContain(run.id)
  })
})

// ── Project-wide fan-out + PM rollup ────────────────────────────────────────

async function seedFileRow(fileId: string, kind: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO files (id, project_id, name, kind, event_id, cell_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .bind(fileId, PROJECT, `${fileId}.${kind}`, kind, `ev-file-${fileId}`)
    .run()
}

describe("listAutopilotCandidateFiles", () => {
  it("returns discourse files with work left, most work first, and skips catalogs", async () => {
    await seedFileRow("f-usfm", "usfm")
    await seedFileRow("f-json", "json")
    await seedFileRow("f-done", "usfm")
    await seedCell("p1", "JHN 1:1", "one", { fileId: "f-usfm" })
    await seedCell("p2", "JHN 1:2", "two", { fileId: "f-usfm" })
    await seedCell("p3", "ui.title", "Title", { fileId: "f-json" })
    await seedCell("p4", "ACT 1:1", "done", { fileId: "f-done", target: "ya traducido" })

    const candidates = await listAutopilotCandidateFiles(db, PROJECT)
    const ids = candidates.map((c) => c.fileId)
    expect(ids).toContain("f-usfm")
    // Key/value catalogs have no discourse to construe.
    expect(ids).not.toContain("f-json")
    // Nothing untranslated left → nothing to do.
    expect(ids).not.toContain("f-done")
    expect(candidates.find((c) => c.fileId === "f-usfm")?.untranslatedCells).toBe(2)
  })

  it("orders by remaining work so the widest fan-out starts on the biggest files", async () => {
    await seedFileRow("f-small", "usfm")
    await seedFileRow("f-big", "usfm")
    await seedCell("s1", "TIT 1:1", "a", { fileId: "f-small" })
    for (let i = 0; i < 4; i++) {
      await seedCell(`b${i}`, `ROM 1:${i + 1}`, "b", { fileId: "f-big" })
    }

    const candidates = await listAutopilotCandidateFiles(db, PROJECT)
    const ids = candidates.map((c) => c.fileId)
    expect(ids.indexOf("f-big")).toBeLessThan(ids.indexOf("f-small"))
  })
})

describe("getProjectAutopilotSummary", () => {
  it("rolls every file's newest run and pending drafts into one PM readout", async () => {
    await seedFourSpans()
    const run = await startRun()
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 2 })

    const summary = await getProjectAutopilotSummary(db, PROJECT)
    const row = summary.files.find((f) => f.fileId === FILE)
    expect(row).toBeTruthy()
    expect(row?.runId).toBe(run.id)
    expect(row?.doneSpans).toBe(2)
    expect(row?.totalSpans).toBe(4)
    expect(row?.proposedDrafts).toBe(2)
    expect(summary.proposedDrafts).toBeGreaterThanOrEqual(2)
    expect(summary.totalSpans).toBeGreaterThanOrEqual(4)
    expect(summary.activeRuns).toBeGreaterThanOrEqual(1)
  })

  it("reports an empty project without inventing rows", async () => {
    const summary = await getProjectAutopilotSummary(db, "proj-with-nothing")
    expect(summary.files).toEqual([])
    expect(summary.activeRuns).toBe(0)
    expect(summary.proposedDrafts).toBe(0)
  })
})
