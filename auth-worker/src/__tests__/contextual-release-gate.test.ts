// The server side of the Autopilot release flag (AQU-1050,
// lib/contextual/release-gate.ts).
//
// WHY these assertions: AQU-1246 made `autopilotEnabled` a project-wide,
// server-stored opt-in that only a project lead may write — and then only the
// BROWSER read it. The flag hid the surface without closing the door, so any
// contributor could POST straight at /contextual/runs in a project that had
// never opted in and spend its org's model budget. Every test here pins one
// half of the fix:
//
//   (a) every door that STARTS or CONTINUES agent work is shut when the flag
//       is off — admission, retries, steering, the react check, the cron, and
//       the team channel's write — and opens the moment a lead flips it on;
//   (b) nothing that READS is shut, and neither is anything that brings work
//       to REST. "Disabling stops new work while preserving history" is the
//       contract, and a gate that also swallowed the history, the pause
//       button or an already-staged draft would make switching off a
//       destructive act nobody would risk.
//
// (b) is the half a future change is most likely to break, which is why the
// read and wind-down cases outnumber the refusals.

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { _test, sweepStrandedContextualRuns } from "../routes/contextual"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { createRun, getRun, insertDrafts, listDraftsByRun } from "../../../db/shared/contextual-runs"
import { reactCheckProject } from "../lib/react-loop"
import {
  AUTOPILOT_RELEASE_KEY,
  isAutopilotReleased,
  readAutopilotReleased,
} from "../lib/contextual/release-gate"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"

const PROJECT = "proj-release-gate"
const FILE = "file-release"
const MOCK_BASE = "http://mock.local/api/v1"

const testEnv = env as typeof env & { OPENROUTER_BASE_URL?: string }
const realFetch = globalThis.fetch

let contrib: string

/** Everything the start gate (AQU-827) needs, so the only thing a refusal
 *  below can be about is the release flag. */
const READY_SETTINGS: Record<string, unknown> = {
  sourceLanguage: "en",
  targetLanguage: "sw",
  translationBrief: { parameters: { purpose: "Community reading" } },
}

async function setReleased(released: boolean | undefined): Promise<void> {
  const settings =
    released === undefined
      ? { ...READY_SETTINGS }
      : { ...READY_SETTINGS, [AUTOPILOT_RELEASE_KEY]: released }
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by)
     VALUES (?, ?, 1, 1)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
  )
    .bind(PROJECT, JSON.stringify(settings))
    .run()
}

function ctx(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(
    `/api/v2/projects/${PROJECT}/contextual${path}`,
    {
      method,
      headers: authHeader(contrib),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )
}

function teamReq(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(
    `/api/v2/projects/${PROJECT}/team${path}`,
    {
      method,
      headers: authHeader(contrib),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )
}

async function refusal(res: Response): Promise<string> {
  const payload = (await res.json()) as { error?: { code?: string } }
  return payload.error?.code ?? ""
}

/** A run row that already exists, so the wind-down and read cases have real
 *  history to preserve. Created through the shared helper rather than the
 *  route, because the route is exactly what the flag is refusing. */
async function seedRun(): Promise<string> {
  const created = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
  if (created.status !== "ok") throw new Error(`run not created: ${created.status}`)
  await insertDrafts(env.AQUILLA_PG, {
    runId: created.run.id,
    projectId: PROJECT,
    fileId: FILE,
    targetLang: "",
    drafts: [{ cellId: "c1", text: "Hapo mwanzo" }],
  })
  return created.run.id
}

beforeEach(async () => {
  testEnv.OPENROUTER_API_KEY = "mock"
  testEnv.OPENROUTER_BASE_URL = MOCK_BASE
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${MOCK_BASE}/chat/completions`) {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.includes("/admin/projects/")) return new Response("{}", { status: 200 })
    throw new Error(`unexpected fetch in release-gate test: ${url}`)
  })

  await seedUser(1, "lead")
  await seedUser(2, "contrib")
  contrib = await jwtFor("contrib")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(PROJECT, "Release Gate")
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 2, 400, 1)",
  )
    .bind(PROJECT)
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
  await setReleased(false)
})

afterEach(async () => {
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  testEnv.OPENROUTER_API_KEY = undefined
  delete testEnv.OPENROUTER_BASE_URL
  vi.stubGlobal("fetch", realFetch)
})

describe("readAutopilotReleased", () => {
  it("is closed by default and strict about the value", async () => {
    // Matches `isAutopilotVisible({}) === false` in src/lib/features/flags.ts:
    // a project that never opted in is not opted in, and the client and the
    // server must not disagree about that.
    expect(readAutopilotReleased(undefined)).toBe(false)
    expect(readAutopilotReleased(null)).toBe(false)
    expect(readAutopilotReleased({})).toBe(false)
    expect(readAutopilotReleased({ autopilotEnabled: false })).toBe(false)
    // A stringy or truthy value is a client bug writing into an unvalidated
    // settings blob, never a lead's consent to spend model budget.
    expect(readAutopilotReleased({ autopilotEnabled: "true" })).toBe(false)
    expect(readAutopilotReleased({ autopilotEnabled: 1 })).toBe(false)
    expect(readAutopilotReleased({ autopilotEnabled: true })).toBe(true)
  })

  it("reads a project with no settings row at all as off", async () => {
    await env.AQUILLA_PG.prepare("DELETE FROM project_settings WHERE project_id = ?")
      .bind(PROJECT)
      .run()
    expect(await isAutopilotReleased(env.AQUILLA_PG, PROJECT)).toBe(false)
  })
})

describe("release flag off — work is refused", () => {
  it("refuses admission with 409 release_disabled before any spend guard", async () => {
    const res = await ctx("POST", "/runs", { fileId: FILE })
    expect(res.status).toBe(409)
    expect(await refusal(res)).toBe("release_disabled")
    // Nothing was created, so nothing has to be cleaned up when the flag
    // comes back on.
    const { results } = await env.AQUILLA_PG
      .prepare("SELECT id FROM contextual_runs WHERE project_id = ?")
      .bind(PROJECT)
      .all<{ id: string }>()
    expect(results).toHaveLength(0)
  })

  it("refuses the retry actions that put a run back to work", async () => {
    const runId = await seedRun()
    for (const action of ["resume", "continue", "continue-all"]) {
      const res = await ctx("POST", `/runs/${runId}/${action}`)
      expect(res.status, action).toBe(409)
      expect(await refusal(res), action).toBe("release_disabled")
    }
  })

  it("refuses a steering direction", async () => {
    const res = await ctx("POST", "/steering", {
      fileId: FILE,
      kind: "direction",
      body: "Keep it formal",
    })
    expect(res.status).toBe(409)
    expect(await refusal(res)).toBe("release_disabled")
    const { results } = await env.AQUILLA_PG
      .prepare("SELECT id FROM contextual_steering WHERE project_id = ?")
      .bind(PROJECT)
      .all<{ id: string }>()
    expect(results).toHaveLength(0)
  })

  it("refuses the manual react check", async () => {
    const res = await ctx("POST", "/react-check")
    expect(res.status).toBe(409)
    expect(await refusal(res)).toBe("release_disabled")
  })

  it("refuses a post to the team channel", async () => {
    const res = await teamReq("POST", "/messages", { text: "Draft Genesis please" })
    expect(res.status).toBe(409)
    expect(await refusal(res)).toBe("release_disabled")
  })

  it("skips the project in the unattended react sweep", async () => {
    // Even with react explicitly switched on: a dial inside a surface the
    // project never opted into must not keep the cron spending budget.
    await env.AQUILLA_PG.prepare(
      "UPDATE project_settings SET settings = ? WHERE project_id = ?",
    )
      .bind(
        JSON.stringify({ ...READY_SETTINGS, agentMode: { react: true, scope: "full" } }),
        PROJECT,
      )
      .run()
    const result = await reactCheckProject(env as never, PROJECT, {
      startRun: async () => {
        throw new Error("the sweep must not start a run for a project with Autopilot off")
      },
      wakeRun: async () => {
        throw new Error("the sweep must not wake a run for a project with Autopilot off")
      },
    })
    await result.done
    expect(result.reactions).toHaveLength(0)
    expect(result.skipped.map((s) => s.reason)).toContain(
      "Autopilot is switched off for this project",
    )
  })

  it("leaves a stranded run alone in the cron sweep, intact for a later re-enable", async () => {
    const runId = await seedRun()
    // 'running' with a stale heartbeat is exactly what a dead Worker request
    // leaves behind — the shape the sweep exists to adopt.
    await env.AQUILLA_PG.prepare(
      `UPDATE contextual_runs
          SET status = 'running', updated_at = now() - interval '1 hour'
        WHERE id = ?`,
    )
      .bind(runId)
      .run()

    const sweep = await sweepStrandedContextualRuns(
      testEnv as unknown as Parameters<typeof sweepStrandedContextualRuns>[0],
    )
    await sweep.done
    _test.lastLoop = null
    expect(sweep.adopted).toBe(0)
    // The run row is untouched beyond the claim's heartbeat, and its staged
    // draft is still there — this is the "preserving history" half.
    const after = await getRun(env.AQUILLA_PG, runId)
    expect(after?.status).toBe("running")
    expect(await listDraftsByRun(env.AQUILLA_PG, PROJECT, runId)).toHaveLength(1)
  })
})

describe("release flag off — history and wind-down stay open", () => {
  it("still serves every read", async () => {
    const runId = await seedRun()
    for (const path of [
      "/overview",
      "/runs",
      `/runs/${runId}/activity`,
      `/drafts?fileId=${FILE}`,
    ]) {
      const res = await ctx("GET", path)
      expect(res.status, path).toBe(200)
    }
    const messages = await teamReq("GET", "/messages")
    expect(messages.status).toBe(200)
  })

  it("still lets a human bring an in-flight run to rest", async () => {
    const runId = await seedRun()
    await env.AQUILLA_PG.prepare("UPDATE contextual_runs SET status = 'running' WHERE id = ?")
      .bind(runId)
      .run()
    // Pause and terminate are the only way out of a run that is already
    // moving; gating them would make switching the flag off a trap.
    const paused = await ctx("POST", `/runs/${runId}/pause`)
    expect(paused.status).toBe(200)
    const terminated = await ctx("POST", `/runs/${runId}/terminate`)
    expect(terminated.status).toBe(200)
    expect((await getRun(env.AQUILLA_PG, runId))?.status).toBe("terminated")
  })

  it("still lets a composer 'stop' reach the run it names", async () => {
    const runId = await seedRun()
    await env.AQUILLA_PG.prepare("UPDATE contextual_runs SET status = 'running' WHERE id = ?")
      .bind(runId)
      .run()
    // The command fast-path is checked BEFORE the flag, so typing "stop"
    // into a composer that is still on screen keeps working.
    const res = await ctx("POST", "/steering", { runId, kind: "direction", body: "stop" })
    expect(res.status).toBe(200)
    expect(await refusal(res)).toBe("")
  })

  it("still lets a human resolve a draft that is already staged", async () => {
    const runId = await seedRun()
    const [draft] = await listDraftsByRun(env.AQUILLA_PG, PROJECT, runId)
    const res = await ctx("POST", `/drafts/${draft.id}/review`, { action: "rejected" })
    expect(res.status).toBe(200)
  })
})

describe("release flag on — the same doors open", () => {
  beforeEach(async () => {
    await setReleased(true)
  })

  it("admits a start, a steering direction, a react check and a channel post", async () => {
    const started = await ctx("POST", "/runs", { fileId: FILE })
    expect(started.status).toBe(201)
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null

    const steered = await ctx("POST", "/steering", {
      fileId: FILE,
      kind: "note",
      body: "Watch the key terms",
    })
    expect(steered.status).toBe(201)

    const react = await ctx("POST", "/react-check")
    expect(react.status).toBe(200)

    const posted = await teamReq("POST", "/messages", { text: "Thanks" })
    expect(posted.status).toBe(201)
  })
})
