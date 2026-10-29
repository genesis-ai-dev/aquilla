// AQU-2115 — the all-projects nightly copy. What has to hold is not "a copy
// function works" (AQU-2114 tests that) but the four things this layer decides
// and nothing else can: WHICH projects, in WHAT order, HOW LONG for, and what
// the run page is told afterwards.
//
// The failures these guard against are all quiet ones. A project set that
// misses voice-only projects leaves their clones silent on dev forever. An
// order without a total tie-break makes a budget-limited backfill re-copy a
// different prefix every night and never converge. A budget checked mid-project
// reports counts that describe nothing. A project that throws taking the whole
// run down means one bad row costs the other four hundred projects their audio.

import { describe, it, expect } from "vitest"
import type { AquillaDb, AquillaStatement } from "../db/shim/postgres"
import type { DevAudioCopyReport } from "./dev-audio-copy"
import {
  copyAllProjectAudio,
  formatCopyAllReport,
  loadAudioProjects,
  numberFlag,
  orderProjects,
  type AudioProject,
} from "./dev-audio-copy-all"

function report(over: Partial<DevAudioCopyReport> = {}): DevAudioCopyReport {
  return {
    projectId: "p",
    dryRun: false,
    source: "aquilla-snapshots",
    destination: "aquilla-snapshots-dev",
    referenced: 0,
    referencedBytes: 0,
    alreadyInDev: 0,
    copied: 0,
    copiedBytes: 0,
    missingInProd: [],
    failed: [],
    skippedUnrecognized: 0,
    skippedUnreferenced: 0,
    samples: [],
    ...over,
  }
}

function project(projectId: string, lastActivityMs: number): AudioProject {
  return { projectId, name: projectId, lastActivityMs }
}

/** A db double that records the one query this module issues and replays rows. */
function fakeDb(rows: Record<string, unknown>[]): { db: AquillaDb; queries: string[] } {
  const queries: string[] = []
  const statement = (query: string): AquillaStatement => ({
    bind: () => statement(query),
    all: async () => ({ results: rows }) as never,
    run: async () => ({ results: [] }) as never,
    first: async () => null,
    raw: async () => [],
  })
  return {
    queries,
    db: {
      prepare: (query: string) => {
        queries.push(query)
        return statement(query)
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      close: async () => {},
    },
  }
}

describe("which projects the copy owes audio to", () => {
  it("asks for all four media sources, not just takes", async () => {
    // Every source `db/shared/media-refs.ts` reads per project has to appear
    // here, or a project whose only media is one of them is never offered a
    // copy and stays silent on dev.
    const { db, queries } = fakeDb([])
    await loadAudioProjects(db)
    expect(queries).toHaveLength(1)
    const sql = queries[0]!
    expect(sql).toMatch(/FROM cell_audio/)
    expect(sql).toMatch(/FROM artifacts/)
    expect(sql).toMatch(/FROM diarization_jobs/)
    expect(sql).toMatch(/project_settings/)
    expect(sql).toMatch(/designPreviewAudioId/)
    expect(sql).toMatch(/customVoice/)
    // AQU-2291: a removed short-clip clone clip is no reason to copy a project.
    expect(sql).not.toMatch(/referenceAudioId/)
  })

  it("counts only live takes, and only live diarization jobs", async () => {
    const { db, queries } = fakeDb([])
    await loadAudioProjects(db)
    expect(queries[0]).toMatch(/WHERE deleted = 0/)
    expect(queries[0]).toMatch(/status IN \('queued', 'running'\)/)
  })

  it("returns one row per project, newest activity first", async () => {
    const { db } = fakeDb([
      { project_id: "old", name: "Old", last_activity_ms: 1_000 },
      { project_id: "new", name: "New", last_activity_ms: 9_000 },
    ])
    expect((await loadAudioProjects(db)).map((p) => p.projectId)).toEqual(["new", "old"])
  })

  it("treats a bigint recency that arrives as a string as the number it is", async () => {
    // postgres.js hands back BIGINT as a string. Compared as strings, "9000"
    // sorts before "1000"'s neighbours and the order quietly inverts.
    const { db } = fakeDb([
      { project_id: "a", name: null, last_activity_ms: "900" },
      { project_id: "b", name: null, last_activity_ms: "1000" },
    ])
    expect((await loadAudioProjects(db)).map((p) => p.projectId)).toEqual(["b", "a"])
  })

  it("keeps a project whose recency is null, at the back", async () => {
    const { db } = fakeDb([
      { project_id: "dated", name: null, last_activity_ms: 5 },
      { project_id: "undated", name: null, last_activity_ms: null },
    ])
    expect((await loadAudioProjects(db)).map((p) => p.projectId)).toEqual(["dated", "undated"])
  })
})

describe("copy order", () => {
  it("puts the most recently active project first", () => {
    const ordered = orderProjects([project("a", 1), project("b", 3), project("c", 2)])
    expect(ordered.map((p) => p.projectId)).toEqual(["b", "c", "a"])
  })

  it("breaks ties by project id, so two budget-limited runs agree", () => {
    // Without a total order each night copies a different prefix of the
    // equally-stale tail and the backfill never converges.
    const ordered = orderProjects([project("z", 0), project("a", 0), project("m", 0)])
    expect(ordered.map((p) => p.projectId)).toEqual(["a", "m", "z"])
  })

  it("does not mutate its input", () => {
    const input = [project("a", 1), project("b", 2)]
    orderProjects(input)
    expect(input.map((p) => p.projectId)).toEqual(["a", "b"])
  })
})

describe("the per-run time budget", () => {
  const deps = (projects: AudioProject[], clock: { t: number }, perProjectMs: number) => ({
    listProjects: async () => projects,
    copyOne: async (projectId: string) => {
      clock.t += perProjectMs
      return report({ projectId, referenced: 10, copied: 10 })
    },
    now: () => clock.t,
  })

  it("stops starting projects once the budget is spent, and says how many are left", async () => {
    const clock = { t: 0 }
    const projects = [project("a", 3), project("b", 2), project("c", 1)]
    const result = await copyAllProjectAudio(deps(projects, clock, 60_000), {
      concurrency: 1,
      budgetMs: 90_000,
    })
    expect(result.projectsDone).toBe(2)
    expect(result.projectsRemaining).toBe(1)
    expect(result.budgetExhausted).toBe(true)
  })

  it("never abandons a project it already started", async () => {
    // A project stopped mid-listing would report counts that describe nothing.
    // Over-budget means "start no more", not "drop this one".
    const clock = { t: 0 }
    const result = await copyAllProjectAudio(
      deps([project("a", 1)], clock, 600_000),
      { concurrency: 1, budgetMs: 1 },
    )
    expect(result.projectsDone).toBe(1)
    expect(result.copied).toBe(10)
  })

  it("reports a finished pass as not budget-limited", async () => {
    const clock = { t: 0 }
    const result = await copyAllProjectAudio(
      deps([project("a", 2), project("b", 1)], clock, 1_000),
      { concurrency: 1, budgetMs: 600_000 },
    )
    expect(result.budgetExhausted).toBe(false)
    expect(result.projectsRemaining).toBe(0)
  })
})

describe("running across every project", () => {
  it("copies in order and aggregates every count", async () => {
    const seen: string[] = []
    const result = await copyAllProjectAudio(
      {
        listProjects: async () => [project("b", 2), project("a", 1)],
        copyOne: async (projectId) => {
          seen.push(projectId)
          return report({
            projectId,
            referenced: 5,
            referencedBytes: 500,
            alreadyInDev: 2,
            copied: 3,
            copiedBytes: 300,
            missingInProd: ["gone"],
            failed: [{ key: "k", error: "boom" }],
          })
        },
        now: () => 0,
      },
      { concurrency: 1 },
    )
    expect(seen).toEqual(["b", "a"])
    expect(result.projectsTotal).toBe(2)
    expect(result.referenced).toBe(10)
    expect(result.referencedBytes).toBe(1_000)
    expect(result.alreadyInDev).toBe(4)
    expect(result.copied).toBe(6)
    expect(result.copiedBytes).toBe(600)
    expect(result.missingInProd).toBe(2)
    expect(result.failedObjects).toBe(2)
  })

  it("keeps going when one project throws, and names it", async () => {
    const result = await copyAllProjectAudio(
      {
        listProjects: async () => [project("bad", 2), project("good", 1)],
        copyOne: async (projectId) => {
          if (projectId === "bad") throw new Error("prefix unreadable")
          return report({ projectId, referenced: 1, copied: 1 })
        },
        now: () => 0,
      },
      { concurrency: 1 },
    )
    expect(result.projectsFailed).toEqual([{ projectId: "bad", error: "prefix unreadable" }])
    expect(result.copied).toBe(1)
    expect(result.projectsDone).toBe(2)
    expect(result.projectsRemaining).toBe(0)
  })

  it("hands each project to exactly one worker when running concurrently", async () => {
    const seen: string[] = []
    const projects = Array.from({ length: 9 }, (_, i) => project(`p${i}`, 9 - i))
    const result = await copyAllProjectAudio(
      {
        listProjects: async () => projects,
        copyOne: async (projectId) => {
          await Promise.resolve()
          seen.push(projectId)
          return report({ projectId })
        },
        now: () => 0,
      },
      { concurrency: 4 },
    )
    expect(seen).toHaveLength(9)
    expect(new Set(seen).size).toBe(9)
    expect(result.projectsDone).toBe(9)
  })

  it("writes nothing on a dry run but still reports what it would copy", async () => {
    const result = await copyAllProjectAudio(
      {
        listProjects: async () => [project("a", 1)],
        copyOne: async (projectId) =>
          report({ projectId, dryRun: true, referenced: 7, alreadyInDev: 2, copied: 0 }),
        now: () => 0,
      },
      { dryRun: true },
    )
    expect(result.copied).toBe(0)
    expect(result.samples).toEqual(["a"])
    expect(formatCopyAllReport(result)).toMatch(/would copy \| 5/)
  })

  it("honours --limit without claiming the rest are done", async () => {
    const result = await copyAllProjectAudio(
      {
        listProjects: async () => [project("a", 3), project("b", 2), project("c", 1)],
        copyOne: async (projectId) => report({ projectId }),
        now: () => 0,
      },
      { limit: 1 },
    )
    expect(result.projectsTotal).toBe(1)
    expect(result.projectsDone).toBe(1)
  })

  it("does nothing, loudly, when no project has media", async () => {
    const result = await copyAllProjectAudio(
      { listProjects: async () => [], copyOne: async () => report(), now: () => 0 },
      {},
    )
    expect(result.projectsTotal).toBe(0)
    expect(result.projectsDone).toBe(0)
    expect(formatCopyAllReport(result)).toMatch(/projects with media \| 0/)
  })
})

describe("the run-page summary", () => {
  it("carries every count the issue asks a run to show", async () => {
    const result = await copyAllProjectAudio(
      {
        listProjects: async () => [project("a", 1)],
        copyOne: async (projectId) =>
          report({
            projectId,
            referenced: 4,
            referencedBytes: 2_000_000,
            alreadyInDev: 1,
            copied: 3,
            copiedBytes: 1_500_000,
            missingInProd: ["gone"],
          }),
        now: () => 0,
      },
      {},
    )
    const summary = formatCopyAllReport(result)
    for (const label of [
      "projects with media",
      "projects done this run",
      "projects remaining",
      "referenced objects",
      "already in dev",
      "copied",
      "missing in prod",
      "failed objects",
      "failed projects",
      "duration",
      "time budget reached",
    ]) {
      expect(summary).toContain(label)
    }
  })

  it("headlines a failure rather than burying it in a row", async () => {
    const result = await copyAllProjectAudio(
      {
        listProjects: async () => [project("bad", 1)],
        copyOne: async () => {
          throw new Error("denied")
        },
        now: () => 0,
      },
      {},
    )
    const summary = formatCopyAllReport(result)
    expect(summary).toMatch(/^## Copy prod audio to dev — ⚠️ 1 project\(s\) failed/)
    expect(summary).toMatch(/`bad`: denied/)
  })

  it("says the backfill is still running when the budget ran out", () => {
    const summary = formatCopyAllReport({
      dryRun: false,
      projectsTotal: 10,
      projectsDone: 4,
      projectsRemaining: 6,
      projectsFailed: [],
      referenced: 0,
      referencedBytes: 0,
      alreadyInDev: 0,
      copied: 0,
      copiedBytes: 0,
      missingInProd: 0,
      failedObjects: 0,
      durationMs: 125_000,
      budgetExhausted: true,
      samples: [],
    })
    expect(summary).toMatch(/time budget reached — the next run resumes/)
    expect(summary).toMatch(/projects remaining \| 6/)
    expect(summary).toMatch(/duration \| 2m 05s/)
  })
})

describe("flag parsing", () => {
  it("takes the value after the flag", () => {
    expect(numberFlag(["--budget-minutes", "20"], "--budget-minutes", 240)).toBe(20)
  })

  it("falls back only when the flag is absent", () => {
    expect(numberFlag(["--dry-run"], "--budget-minutes", 240)).toBe(240)
  })

  it("refuses a typo rather than silently using the default", () => {
    // Quietly holding the workflow open for the 4-hour default when the
    // operator asked for 20 minutes looks exactly like success.
    const bads = [
      ["--concurrency"], // nothing after it
      ["--concurrency", "--dry-run"], // the next flag, not a value
      ["--concurrency", "0"],
      ["--concurrency", "-2"],
      ["--concurrency", "lots"],
    ]
    for (const bad of bads) {
      expect(() => numberFlag(bad, "--concurrency", 4)).toThrow(/positive number/)
    }
  })
})
