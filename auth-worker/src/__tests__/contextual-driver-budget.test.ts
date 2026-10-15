// AQU-1845 — what `selfTickLoop` does when its wave budget runs out.
//
// The driver's end state is the whole safety property here. A run left
// `running` with nothing driving it is unrescuable: `resumeRun` refuses a
// running run, so only a human terminating it ends the spinner. That is why
// the pre-AQU-1845 loop parked at its 50-wave cap rather than just returning.
//
// A Durable Object driver bounds itself per INVOCATION, not per run, and that
// bound must not be read as "this run is out of road": it re-arms and keeps
// going. So the loop now asks, and the answer decides the run's state.
//
// What this guards:
//   1. A re-arming driver leaves the run `running` — parking it instead would
//      show the user "awaiting input" on a run that is still being worked.
//   2. A driver that cannot re-arm still PARKS. This is the fallback path
//      (no DO binding) and the regression that would strand runs.
//   3. The budget is actually honoured — a hook that never fires would make
//      both of the above vacuous.
import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { selfTickLoop } from "../routes/contextual"
import { createRun, getRun } from "../../../db/shared/contextual-runs"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"

const PROJECT = "proj-driver-budget"
const FILE = "file-budget"
const MOCK_BASE = "http://mock.local/api/v1"

const testEnv = env as typeof env & { OPENROUTER_BASE_URL?: string }
const realFetch = globalThis.fetch

beforeEach(() => {
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
    // Sync-worker progress fan-out — irrelevant here.
    if (url.includes("/admin/projects/")) return new Response("{}", { status: 200 })
    throw new Error(`unexpected fetch in driver budget test: ${url}`)
  })
})

afterEach(() => {
  testEnv.OPENROUTER_API_KEY = undefined
  delete testEnv.OPENROUTER_BASE_URL
  vi.stubGlobal("fetch", realFetch)
})

/** Enough cells, spread over chapters, that one single-span wave cannot
 *  finish the file — otherwise the budget is never reached and the assertions
 *  below are vacuous. */
async function seedWorld(): Promise<string> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(PROJECT, "Driver Budget")
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by)
     VALUES (?, ?, 1, 1)`,
  )
    .bind(
      PROJECT,
      JSON.stringify({
        sourceLanguage: "en",
        targetLanguage: "sw",
        translationBrief: { parameters: { purpose: "Community reading" } },
        autopilotEnabled: true,
      }),
    )
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
     VALUES ('dbg-src', ?, 'source', 'English', NULL, 0), ('dbg-tgt', ?, 'target', 'Swahili', '', 1)`,
  )
    .bind(PROJECT, PROJECT)
    .run()
  for (let chapter = 1; chapter <= 3; chapter++) {
    for (let verse = 1; verse <= 4; verse++) {
      const cellId = `c${chapter}-${verse}`
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
         VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
      )
        .bind(PROJECT, FILE, cellId, `verse ${chapter}:${verse}`, `MRK ${chapter}:${verse}`, `ev-${cellId}`)
        .run()
    }
  }
  const created = await createRun(env.AQUILLA_PG, {
    projectId: PROJECT,
    fileId: FILE,
    targetLang: "",
    initiatedBy: "test",
    // Unlimited: the trust-gated default allowance would park the run inside
    // runOneTick after its first span, and the loop would never reach the
    // wave budget this file is about.
    spanAllowance: null,
  })
  if (created.status !== "ok") throw new Error(`seed run failed: ${created.status}`)
  return created.run.id
}

describe("selfTickLoop wave budget (AQU-1845)", () => {
  it("keeps the run running when the driver re-arms, and parks it when it cannot", async () => {
    const rearming = await seedWorld()
    let asked = 0
    await selfTickLoop(env, PROJECT, rearming, 1, {
      maxWaves: 1,
      onWaveBudgetExhausted: async () => {
        asked += 1
        return true
      },
    })
    expect(asked).toBe(1)
    // Still `running`: a driver is scheduled, so "awaiting input" would be a
    // lie to the user and would need a Continue click the run does not need.
    expect((await getRun(env.AQUILLA_PG, rearming))?.status).toBe("running")
  })

  it("parks at the budget when there is no driver to re-arm", async () => {
    const parking = await seedWorld()
    await selfTickLoop(env, PROJECT, parking, 1, { maxWaves: 1 })
    const run = await getRun(env.AQUILLA_PG, parking)
    expect(run?.status).toBe("parked")
    // `awaiting_input`, not `work_exhausted` (AQU-1300): work IS still queued,
    // and the reason is what surfaces Continue.
    expect(run?.parkReason).toBe("awaiting_input")
  })

  it("parks when the re-arm itself fails, rather than stranding the run", async () => {
    const failing = await seedWorld()
    await selfTickLoop(env, PROJECT, failing, 1, {
      maxWaves: 1,
      onWaveBudgetExhausted: async () => {
        throw new Error("setAlarm failed")
      },
    })
    expect((await getRun(env.AQUILLA_PG, failing))?.status).toBe("parked")
  })
})
