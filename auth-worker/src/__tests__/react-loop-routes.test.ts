// The react watcher and its manual "check for updates now" route
// (lib/react-loop.ts + routes/contextual.ts, 2026-08-28 social-workspace
// design §v3).
//
// WHY these assertions: this is the first surface in the product that spends
// model budget with NO human in the loop, so what has to hold is (a) it fires
// on genuine human expert input and seeds the run with a direction naming the
// trigger and the scope — a reaction nobody can trace back to a cause is just
// noise; (b) every anti-noise gate the design names actually gates (debounce,
// one open reaction per file, cooldown), because the failure mode is a project
// that reacts to itself; (c) the cursor advances past exactly what was
// CONSIDERED and not one millisecond further, or debounced edits are lost
// forever; and (d) the write floor is CONTRIBUTOR, matching steering, because
// starting a run is starting translation work product.

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { _test } from "../routes/contextual"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { createRun, getRun } from "../../../db/shared/contextual-runs"
import { loadProjectSettings } from "../../../db/shared/projects"
import { readAgentReactState } from "../lib/agent-mode"
import {
  REACT_DEBOUNCE_MS,
  runReactSweep,
  type StartReactionRunInput,
} from "../lib/react-loop"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"

const PROJECT = "proj-react"
const FILE = "file-react"
const MOCK_BASE = "http://mock.local/api/v1"
const MINUTE = 60_000

const testEnv = env as typeof env & { OPENROUTER_BASE_URL?: string }
const realFetch = globalThis.fetch

let contrib: string
let viewer: string

beforeEach(async () => {
  testEnv.OPENROUTER_API_KEY = "mock"
  testEnv.OPENROUTER_BASE_URL = MOCK_BASE
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${MOCK_BASE}/chat/completions`) {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[]
      }
      return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.includes("/admin/projects/")) return new Response("{}", { status: 200 })
    throw new Error(`unexpected fetch in react test: ${url}`)
  })

  await seedUser(1, "lead")
  await seedUser(2, "contrib")
  await seedUser(3, "viewer")
  contrib = await jwtFor("contrib")
  viewer = await jwtFor("viewer")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(PROJECT, "React Loop")
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 2, 400, 1), (?, 3, 100, 1)",
  )
    .bind(PROJECT, PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, kind, event_id) VALUES (?, ?, 'Mark', 'usfm', 'ev-file')",
  )
    .bind(FILE, PROJECT)
    .run()
  for (const [cellId, ref, text] of [
    ["c1", "MRK 1:1", "In the beginning"],
    ["c2", "MRK 1:2", "was the word"],
  ] as const) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, cellId, text, ref, `ev-${cellId}`)
      .run()
  }
})

afterEach(async () => {
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  testEnv.OPENROUTER_API_KEY = undefined
  delete testEnv.OPENROUTER_BASE_URL
  vi.stubGlobal("fetch", realFetch)
})

// ── Fixtures ────────────────────────────────────────────────────────────────

async function setSettings(settings: Record<string, unknown>): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by)
     VALUES (?, ?, 1, 1)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
  )
    .bind(PROJECT, JSON.stringify(settings))
    .run()
}

let seq = 0

/** One human target commit `agoMs` milliseconds in the past. */
async function seedHumanCommit(
  agoMs: number,
  opts?: { id?: string; cellId?: string; kind?: string; payload?: Record<string, unknown> },
): Promise<number> {
  const ts = Date.now() - agoMs
  seq += 1
  await env.AQUILLA_PG.prepare(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author,
                         payload, client_ts, server_ts, server_seq)
     VALUES (?, 1, ?, ?, ?, ?, 'contrib', ?, ?, ?, ?)`,
  )
    .bind(
      opts?.id ?? `ev-human-${agoMs}`,
      PROJECT,
      FILE,
      opts?.cellId ?? "c1",
      opts?.kind ?? "target.cell.commit",
      JSON.stringify(opts?.payload ?? {}),
      ts,
      ts,
      seq,
    )
    .run()
  return ts
}

interface ReactCheckBody {
  reactions: { fileId: string; runId: string }[]
  skipped: { fileId: string | null; reason: string }[]
}

async function reactCheck(jwt = contrib): Promise<{ status: number; body: ReactCheckBody }> {
  const res = await app.request(
    `/api/v2/projects/${PROJECT}/contextual/react-check`,
    { method: "POST", headers: authHeader(jwt) },
    env,
  )
  const body = res.status === 200 ? ((await res.json()) as ReactCheckBody) : { reactions: [], skipped: [] }
  // Settle the driver the reaction kicked before anything asserts on run state.
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  return { status: res.status, body }
}

async function reactState() {
  const stored = await loadProjectSettings(env.AQUILLA_PG, PROJECT)
  return readAgentReactState(stored.settings)
}

async function storedDirections(runId: string): Promise<string[]> {
  const { results } = await env.AQUILLA_PG
    .prepare(
      "SELECT body FROM contextual_steering WHERE run_id = ? AND kind = 'direction' ORDER BY created_at ASC",
    )
    .bind(runId)
    .all<{ body: string }>()
  return results.map((row) => row.body)
}

async function coordinatorTexts(): Promise<string[]> {
  const { results } = await env.AQUILLA_PG
    .prepare(
      `SELECT body ->> 'text' AS text FROM team_messages
        WHERE project_id = ? AND body_kind = 'text' AND author_id = 'coordinator'`,
    )
    .bind(PROJECT)
    .all<{ text: string | null }>()
  return results.map((row) => row.text ?? "")
}

// ── The happy path ──────────────────────────────────────────────────────────

describe("POST /contextual/react-check", () => {
  it("reacts to a settled human commit: run, steering, channel note, cursor", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    const eventTs = await seedHumanCommit(5 * MINUTE)

    const { status, body } = await reactCheck()
    expect(status).toBe(200)
    expect(body.reactions).toHaveLength(1)
    expect(body.reactions[0].fileId).toBe(FILE)

    // The run is attributable as a reaction — this is what the conversation
    // list badges as "reacted to your changes".
    const run = await getRun(env.AQUILLA_PG, body.reactions[0].runId)
    expect(run?.initiatedBy).toBe("reaction")
    expect(run?.fileId).toBe(FILE)
    // Anchored at the cell the human was working in.
    expect(run?.anchorCellId).toBe("c1")

    // The auto-steering names the trigger AND the scope's licence to redraft.
    const directions = await storedDirections(body.reactions[0].runId)
    expect(directions).toHaveLength(1)
    expect(directions[0]).toContain("React to 1 human edit near MRK 1:1")
    expect(directions[0]).toContain("update drafts where the human's changes have implications")

    // A durable coordinator note says why the thread exists.
    const texts = await coordinatorTexts()
    expect(texts.some((t) => t.includes("Reacting to 1 human edit near MRK 1:1"))).toBe(true)

    // The cursor consumed the whole debounce window, so the same edit cannot
    // start a second reaction on the next sweep.
    const state = await reactState()
    expect(state.cursor).not.toBeNull()
    expect(state.cursor as number).toBeGreaterThan(eventTs)
    expect(state.lastReactionAt[FILE]).toBeTruthy()
  })

  it("writes the qa scope's verify-only direction", async () => {
    await setSettings({ agentMode: { react: true, scope: "qa" } })
    await seedHumanCommit(5 * MINUTE)

    const { body } = await reactCheck()
    expect(body.reactions).toHaveLength(1)
    const directions = await storedDirections(body.reactions[0].runId)
    expect(directions[0]).toContain("verify and report on the surrounding drafts")
    expect(directions[0]).toContain("do not redraft unless a check fails")
  })

  it("counts validations as expert input and reports the plural", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE, { id: "ev-commit", cellId: "c1" })
    await seedHumanCommit(4 * MINUTE, { id: "ev-validate", cellId: "c2", kind: "cell.validate" })

    const { body } = await reactCheck()
    expect(body.reactions).toHaveLength(1)
    const directions = await storedDirections(body.reactions[0].runId)
    expect(directions[0]).toContain("React to 2 human edits near MRK 1:1, MRK 1:2")
    // The anchor is the most recent edit, not the first one seen.
    expect((await getRun(env.AQUILLA_PG, body.reactions[0].runId))?.anchorCellId).toBe("c2")
  })
})

// ── The cron sweep ──────────────────────────────────────────────────────────

describe("runReactSweep", () => {
  it("visits only live projects whose settings blob has react on", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE)
    // A second project with react OFF must not be swept — the candidate query
    // reads the generated `agent_react` column, never the settings blob.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, created_by) VALUES ('proj-react-off', 'Off', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by)
       VALUES ('proj-react-off', ?, 1, 1)`,
    )
      .bind(JSON.stringify({ agentMode: { react: false } }))
      .run()

    const visited: StartReactionRunInput[] = []
    const sweep = await runReactSweep(env, {
      startRun: async (_env, input) => {
        visited.push(input)
        return { status: "ok", runId: "stub-run", done: Promise.resolve() }
      },
      wakeRun: async () => ({ status: "skipped", reason: "unexpected wake in this test" }),
    })
    await sweep.done

    expect(sweep.projects).toBe(1)
    expect(visited).toHaveLength(1)
    expect(visited[0]).toMatchObject({ projectId: PROJECT, fileId: FILE, anchorCellId: "c1" })
    expect(visited[0].direction).toContain("React to 1 human edit near MRK 1:1")
    expect(sweep.reactions).toEqual([
      { projectId: PROJECT, fileId: FILE, runId: "stub-run" },
    ])
  })
})

// ── The gates ───────────────────────────────────────────────────────────────

describe("react-check gates", () => {
  it("debounces fresh edits and leaves them UNCONSUMED for the next sweep", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    const eventTs = await seedHumanCommit(5_000)

    const { body } = await reactCheck()
    expect(body.reactions).toEqual([])

    // The cursor stopped at the debounce boundary — strictly before the event
    // — so the edit is still in the unconsumed range and a later sweep will
    // see it. (That it then reacts is the happy-path case above; what is
    // load-bearing HERE is that the cursor did not step over it.)
    const state = await reactState()
    expect(state.cursor as number).toBeLessThan(eventTs)
    expect(state.cursor as number).toBeLessThanOrEqual(Date.now() - REACT_DEBOUNCE_MS)
    // Nothing was skipped either — a debounced edit is pending, not judged.
    expect(body.skipped).toEqual([])
  })

  it("holds off while a run is already active on the file", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE)
    const existing = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    expect(existing.status).toBe("ok")

    const { body } = await reactCheck()
    expect(body.reactions).toEqual([])
    expect(body.skipped).toEqual([
      { fileId: FILE, reason: "a run is already active on this file" },
    ])
  })

  it("wakes a PARKED run with the reaction steering instead of starting a rival", async () => {
    // Every finished reaction parks — if parked blocked like active does, a
    // file's FIRST reaction would be its last. The reaction must continue the
    // parked run's own conversation.
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE)
    const existing = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    expect(existing.status).toBe("ok")
    const parkedId = existing.status === "ok" ? existing.run.id : ""
    await env.AQUILLA_PG.prepare("UPDATE contextual_runs SET status='parked' WHERE id = ?")
      .bind(parkedId)
      .run()

    const { body } = await reactCheck()
    expect(body.skipped).toEqual([])
    expect(body.reactions).toEqual([{ fileId: FILE, runId: parkedId }])
    // The steering landed on the WOKEN run, and the run actually DROVE —
    // it may well re-park after finishing the work (that is a reaction run's
    // normal resting state), so progress, not status, is the proof of waking.
    const directions = await storedDirections(parkedId)
    expect(directions.some((d) => d.includes("React to 1 human edit"))).toBe(true)
    const woken = await getRun(env.AQUILLA_PG, parkedId)
    expect(woken?.doneSpans ?? 0).toBeGreaterThan(0)
  })

  it("never overrides a PAUSED run — a person asked for quiet on that file", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE)
    const existing = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    expect(existing.status).toBe("ok")
    const pausedId = existing.status === "ok" ? existing.run.id : ""
    await env.AQUILLA_PG.prepare("UPDATE contextual_runs SET status='paused' WHERE id = ?")
      .bind(pausedId)
      .run()

    const { body } = await reactCheck()
    expect(body.reactions).toEqual([])
    expect(body.skipped).toEqual([
      { fileId: FILE, reason: "a person paused the run on this file" },
    ])
    expect((await getRun(env.AQUILLA_PG, pausedId))?.status).toBe("paused")
  })

  it("honours the per-file cooldown", async () => {
    await setSettings({
      agentMode: { react: true, scope: "full" },
      agentReactState: {
        cursor: Date.now() - 30 * MINUTE,
        lastReactionAt: { [FILE]: new Date(Date.now() - MINUTE).toISOString() },
      },
    })
    await seedHumanCommit(5 * MINUTE)

    const { body } = await reactCheck()
    expect(body.reactions).toEqual([])
    expect(body.skipped).toEqual([{ fileId: FILE, reason: "cooldown" }])
  })

  it("ignores the agent's own commits, so a reaction cannot react to itself", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE, {
      id: "ev-agent",
      payload: { agent_run_id: "run-abc" },
    })

    const { body } = await reactCheck()
    expect(body.reactions).toEqual([])
    expect(body.skipped).toEqual([])
  })

  it("does nothing at all when react mode is off", async () => {
    await setSettings({ agentMode: { react: false, scope: "full" } })
    await seedHumanCommit(5 * MINUTE)

    const { body } = await reactCheck()
    expect(body.reactions).toEqual([])
    expect(body.skipped).toEqual([
      { fileId: null, reason: "react mode is off for this project" },
    ])
    // An off project must not even move its cursor — nothing was considered.
    expect((await reactState()).cursor).toBeNull()
  })

  it("skips non-discourse files", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await env.AQUILLA_PG.prepare("UPDATE files SET kind = 'json' WHERE id = ?").bind(FILE).run()
    await seedHumanCommit(5 * MINUTE)

    const { body } = await reactCheck()
    expect(body.reactions).toEqual([])
    expect(body.skipped).toEqual([{ fileId: FILE, reason: "not a discourse file" }])
  })

  it("does not sweep a project that has been archived or deactivated", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE)
    await env.AQUILLA_PG.prepare("UPDATE projects SET archived_at = now() WHERE id = ?")
      .bind(PROJECT)
      .run()

    const visited: StartReactionRunInput[] = []
    const sweep = await runReactSweep(env, {
      startRun: async (_env, input) => {
        visited.push(input)
        return { status: "skipped", reason: "stubbed" }
      },
      wakeRun: async () => ({ status: "skipped", reason: "unexpected wake in this test" }),
    })
    await sweep.done
    expect(sweep.projects).toBe(0)
    expect(visited).toEqual([])
  })

  it("requires CONTRIBUTOR", async () => {
    await setSettings({ agentMode: { react: true, scope: "full" } })
    await seedHumanCommit(5 * MINUTE)

    const res = await app.request(
      `/api/v2/projects/${PROJECT}/contextual/react-check`,
      { method: "POST", headers: authHeader(viewer) },
      env,
    )
    expect(res.status).toBe(403)
    // A denied request must not have swept anything.
    expect((await reactState()).cursor).toBeNull()
  })
})
