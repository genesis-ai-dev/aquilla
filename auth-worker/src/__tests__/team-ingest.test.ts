// Server-side write-through from autopilot activity into the team channel
// (lib/team-ingest.ts, 2026-08-28 social-workspace design §v2 sequencing
// step 2).
//
// WHY these assertions: this replaces v1's per-user, client-side derivation
// (src/lib/agent/social-feed.ts) with the durable multiplayer history, so the
// contract is that the two derivations AGREE — same personas, same skipped
// kinds, same consecutive-phase collapse — and that the channel is strictly
// subordinate to the pipeline: a channel failure must not fail a run.
//
// The producer under test is `persistContextualProgressFrame`, the real and
// only server-side path that records narrative activity. Driving the frames
// (rather than hand-built event rows) is what makes this a producer→consumer
// test instead of two fixtures agreeing with each other.

import { env } from "cloudflare:test"
import { pg } from "./helpers/pg-test-env"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { persistContextualProgressFrame } from "../lib/contextual/tick"
import { ingestRunActivity, mapRunEvent } from "../lib/team-ingest"
import { readPage } from "../lib/team-channel"
import { listContextualRunEvents } from "../../../db/shared/contextual-runs"
import type { AquillaDb } from "../../../db/shim/postgres"
import type { ContextualRunEvent } from "../../../db/shared/contextual-runs"
import type { TeamActivityBody, TeamMessage, TeamTextBody } from "../../../shared/team-channel"

const PROJECT = "proj-ingest"
const FILE = "file-gen"
const RUN = "run-0001"
const SPAN = "span-a"
const scope = { projectId: PROJECT, fileId: FILE }

function bodies(messages: TeamMessage[]): TeamActivityBody[] {
  return messages.map((m) => m.body as TeamActivityBody)
}

async function main(): Promise<TeamMessage[]> {
  const result = await readPage(env.AQUILLA_PG, { projectId: PROJECT })
  if (result.status !== "ok") throw new Error(result.status)
  return result.page.messages
}

async function threadRow(): Promise<{ id: string; title: string; source_ref: string }> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT id, title, source_ref FROM team_threads WHERE project_id = ?",
  )
    .bind(PROJECT)
    .first<{ id: string; title: string; source_ref: string }>()
  if (!row) throw new Error("no thread")
  return row
}

async function threadMessages(): Promise<TeamMessage[]> {
  const result = await readPage(env.AQUILLA_PG, {
    projectId: PROJECT,
    threadId: (await threadRow()).id,
  })
  if (result.status !== "ok") throw new Error(result.status)
  return result.page.messages
}

beforeEach(async () => {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, 'Translation', 1)",
  )
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES (?, ?, 'Genesis', 'evt-1')",
  )
    .bind(FILE, PROJECT)
    .run()
})

describe("autopilot activity write-through", () => {
  it("opens a thread with a Coordinator dispatch in the main channel and narrates inside it", async () => {
    await persistContextualProgressFrame(env.AQUILLA_PG, scope, {
      type: "contextual.span.start",
      runId: RUN,
      fileId: FILE,
      targetLang: "es",
      spanId: SPAN,
      spanLabel: "GEN 1:1–GEN 1:8",
    })
    await persistContextualProgressFrame(env.AQUILLA_PG, scope, {
      type: "contextual.drafts",
      runId: RUN,
      fileId: FILE,
      targetLang: "es",
      spanId: SPAN,
      spanLabel: "GEN 1:1–GEN 1:8",
      draftCount: 8,
      drafts: [{ draftId: "d1", cellId: "c1", text: "En el principio" }],
    })

    // One thread for the run, titled by the file it is translating.
    const thread = await threadRow()
    expect(thread.source_ref).toBe(RUN)
    expect(thread.title).toBe("Genesis")

    // Exactly one main-channel dispatch, and it owns the thread.
    const channel = await main()
    expect(channel).toHaveLength(1)
    expect(channel[0].author).toEqual({ kind: "persona", id: "coordinator" })
    expect(channel[0].bodyKind).toBe("text")
    expect(channel[0].body as TeamTextBody).toEqual({
      text: "Working on Genesis",
      threadId: thread.id,
    })

    // The play-by-play lives in the thread, oldest first.
    const inThread = await threadMessages()
    expect(inThread.map((m) => m.author)).toEqual([
      { kind: "persona", id: "coordinator" },
      { kind: "persona", id: "coordinator" },
    ])
    expect(inThread.every((m) => m.bodyKind === "activity")).toBe(true)
    expect(bodies(inThread)).toEqual([
      { kind: "started", spanId: SPAN, spanLabel: "GEN 1:1–GEN 1:8" },
      { kind: "draftsStaged", spanId: SPAN, spanLabel: "GEN 1:1–GEN 1:8", count: 8 },
    ])
  })

  it("attributes each phase to the same teammate the client feed would", async () => {
    for (const phase of ["reading", "drafting", "checking", "staging"] as const) {
      await persistContextualProgressFrame(env.AQUILLA_PG, scope, {
        type: "contextual.phase",
        runId: RUN,
        spanId: SPAN,
        spanLabel: "GEN 1:1",
        phase,
      })
    }
    await persistContextualProgressFrame(env.AQUILLA_PG, scope, {
      type: "contextual.scene",
      runId: RUN,
      spanId: SPAN,
      spanLabel: "GEN 1:1",
      sceneBriefId: "brief-1",
      ambiguityCount: 2,
    })
    await persistContextualProgressFrame(env.AQUILLA_PG, scope, {
      type: "contextual.span",
      runId: RUN,
      spanId: SPAN,
      spanLabel: "GEN 1:1",
      verdictSummary: "3 staged, 1 skipped",
      outcome: "complete",
      staged: 3,
      skipped: 1,
      reasons: ["target_already_filled"],
      calls: 4,
      units: 12,
    })

    const inThread = await threadMessages()
    // 'staging' is skipped — drafts_staged/span_outcome already narrate it.
    expect(inThread.map((m) => m.author.id)).toEqual([
      "drafter", // reading
      "drafter", // drafting
      "reviewer", // checking
      "drafter", // scene_ready
      "coordinator", // span_outcome
    ])
    expect(bodies(inThread).map((b) => b.kind)).toEqual([
      "phase",
      "phase",
      "phase",
      "sceneReady",
      "outcome",
    ])
    expect(inThread[3].body).toEqual({
      kind: "sceneReady",
      spanId: SPAN,
      spanLabel: "GEN 1:1",
      ambiguityCount: 2,
    })
    // A span that skipped work reads as partial, not done.
    expect(inThread[4].body).toEqual({
      kind: "outcome",
      spanId: SPAN,
      spanLabel: "GEN 1:1",
      status: "partial",
      reasons: ["target_already_filled"],
    })
  })

  it("collapses repeated phase updates per span but not across spans", async () => {
    const phase = (spanId: string, p: "reading" | "drafting") =>
      persistContextualProgressFrame(env.AQUILLA_PG, scope, {
        type: "contextual.phase",
        runId: RUN,
        spanId,
        spanLabel: spanId,
        phase: p,
      })
    await phase("span-a", "reading")
    await phase("span-a", "reading") // duplicate — dropped
    await phase("span-b", "reading") // different span — kept
    await phase("span-a", "drafting") // region changed — kept
    await phase("span-a", "reading") // moved back — kept

    const inThread = await threadMessages()
    expect(
      bodies(inThread).map((b) => [
        (b as { spanId: string }).spanId,
        (b as { region: string }).region,
      ]),
    ).toEqual([
      ["span-a", "reading"],
      ["span-b", "reading"],
      ["span-a", "drafting"],
      ["span-a", "reading"],
    ])
  })

  it("skips plumbing events entirely — no thread, no dispatch", async () => {
    await persistContextualProgressFrame(env.AQUILLA_PG, scope, {
      type: "contextual.run.state",
      runId: RUN,
      fileId: FILE,
      targetLang: "es",
      status: "running",
      done: 0,
      total: 4,
      failed: 0,
    })
    expect(await main()).toEqual([])
    const threads = await env.AQUILLA_PG.prepare(
      "SELECT count(*)::int AS n FROM team_threads WHERE project_id = ?",
    )
      .bind(PROJECT)
      .first<{ n: number }>()
    expect(threads?.n).toBe(0)
    // The run event itself is still recorded — the skip is a channel decision.
    const events = await listContextualRunEvents(env.AQUILLA_PG, {
      projectId: PROJECT,
      runId: RUN,
    })
    expect(events.events.map((e) => e.kind)).toEqual(["run_state"])
  })

  it("skips the non-narrative kinds the client feed also skips", () => {
    const event = (kind: ContextualRunEvent["kind"]): ContextualRunEvent => ({
      id: crypto.randomUUID(),
      runId: RUN,
      projectId: PROJECT,
      fileId: FILE,
      kind,
      spanId: SPAN,
      spanLabel: "GEN 1:1",
      status: null,
      phase: null,
      summary: "",
      details: {},
      createdAt: new Date().toISOString(),
    })
    for (const kind of ["run_created", "run_state", "steering_queued", "draft_reviewed"] as const) {
      expect(mapRunEvent(event(kind))).toBeNull()
    }
    expect(mapRunEvent({ ...event("phase"), phase: "staging" })).toBeNull()
    expect(mapRunEvent({ ...event("phase"), phase: "checking" })?.persona).toBe("reviewer")
  })

  it("never fails the pipeline when the channel write fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    // Take the channel offline underneath a live run, the way a bad migration
    // or a revoked grant would.
    await pg.exec("ALTER TABLE team_messages RENAME TO team_messages_offline")
    try {
      await expect(
        persistContextualProgressFrame(env.AQUILLA_PG, scope, {
          type: "contextual.span.start",
          runId: RUN,
          fileId: FILE,
          targetLang: "es",
          spanId: SPAN,
          spanLabel: "GEN 1:1",
        }),
      ).resolves.toBeUndefined()
      // The durable run event — the pipeline's own telemetry — still landed.
      const events = await listContextualRunEvents(env.AQUILLA_PG, {
        projectId: PROJECT,
        runId: RUN,
      })
      expect(events.events.map((e) => e.kind)).toEqual(["span_started"])
      expect(logged).toHaveBeenCalled()
    } finally {
      await pg.exec("ALTER TABLE team_messages_offline RENAME TO team_messages")
      logged.mockRestore()
    }
  })

  it("swallows a completely unusable database handle", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const broken = {
      prepare: () => {
        throw new Error("connection closed")
      },
    } as unknown as AquillaDb
    await expect(
      ingestRunActivity(broken, {
        id: crypto.randomUUID(),
        runId: RUN,
        projectId: PROJECT,
        fileId: FILE,
        kind: "span_started",
        spanId: SPAN,
        spanLabel: "GEN 1:1",
        status: "started",
        phase: null,
        summary: "",
        details: {},
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})
