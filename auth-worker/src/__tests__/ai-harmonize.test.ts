// Contract tests for POST /api/v1/ai/harmonize/passage (AQU-1657).
//
// Two properties carry the route: it turns Jev's reading of the SOURCE into an
// exact-span suggestion (John 6:27 gets its closing quotation mark), and it can
// never fail the editor that asked — every degraded path answers 200 with no
// suggestions, because nobody requested these and nobody should see an error
// about them. A passage with nothing to ask must not spend a Jev call at all.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const PROJECT_ID = "harmonize-project"

const JOHN_6 = [
  {
    fileId: "JHN", cellId: "JHN 6:26", ref: "JHN 6:26",
    source: "ἀπεκρίθη αὐτοῖς ὁ Ἰησοῦς καὶ εἶπεν· ἀμὴν ἀμὴν λέγω ὑμῖν…",
    target: "Jesus answered them, “Truly, truly, I say to you…",
  },
  {
    fileId: "JHN", cellId: "JHN 6:27", ref: "JHN 6:27",
    source: "ἐργάζεσθε μὴ τὴν βρῶσιν τὴν ἀπολλυμένην… τοῦτον γὰρ ὁ πατὴρ ἐσφράγισεν ὁ θεός.",
    target: "Do not work for the food that perishes… For on him God the Father has set his seal.",
  },
  {
    fileId: "JHN", cellId: "JHN 6:28", ref: "JHN 6:28",
    source: "εἶπον οὖν πρὸς αὐτόν· τί ποιῶμεν…;",
    target: "Then they said to him, “What must we do?”",
  },
]

function testEnv(overrides: Record<string, unknown> = {}): typeof env {
  return Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key", ...overrides })
}

async function seedMember(): Promise<string> {
  await seedUser(1, "harmony-owner")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'Harmonize', 1)")
    .bind(PROJECT_ID)
    .run()
  return jwtFor("harmony-owner")
}

const post = (jwt: string, cells: unknown, e = testEnv()) =>
  app.request(
    "/api/v1/ai/harmonize/passage",
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId: PROJECT_ID, cells }) },
    e,
  )

/** Jev places the end of Jesus's speech at the very end of v.27. */
function jevClosesInV27(): Response {
  return new Response(JSON.stringify({
    answers: {
      h0_s0: { type: "choice", choice: "c1", probabilities: { c0: 0.04, c1: 0.96 } },
      h0_s0_end0: { type: "noul", noul: 0.1 },
      h0_s0_end1: { type: "noul", noul: 0.92 },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } })
}

afterEach(() => vi.restoreAllMocks())

describe("POST /api/v1/ai/harmonize/passage", () => {
  it("John 6: suggests closing the quotation at the end of v.27, asking the source in one call", async () => {
    const jwt = await seedMember()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevClosesInV27())

    const res = await post(jwt, JOHN_6)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { suggestions: Record<string, unknown>[]; jev: string }
    expect(body.jev).toBe("model")
    expect(body.suggestions).toEqual([expect.objectContaining({
      fileId: "JHN",
      cellId: "JHN 6:27",
      old: "seal.",
      new: "seal.”",
      checkId: "textual.quotation",
      reasonKey: "harmonizer.quotes.closeHere",
      reasonValues: { openedIn: "JHN 6:26" },
    })])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { state: { cells: { source: string }[] } }
    expect(sent.state.cells[1].source).toContain("ἐσφράγισεν")
  })

  it("spends no Jev call on a passage with nothing to ask", async () => {
    const jwt = await seedMember()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const fixed = JOHN_6.map((c, i) => (i === 1 ? { ...c, target: c.target + "”" } : c))
    const res = await post(jwt, fixed)
    expect(await res.json()).toEqual({ suggestions: [], jev: "skipped" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("never fails the editor: an upstream error is no suggestions, not an error", async () => {
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }))
    const res = await post(jwt, JOHN_6)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ suggestions: [], jev: "upstream" })
  })

  it("answers with nothing when switched off", async () => {
    const jwt = await seedMember()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await post(jwt, JOHN_6, testEnv({ HARMONIZER: "off" }))
    expect(await res.json()).toMatchObject({ suggestions: [], disabled: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses someone outside the project", async () => {
    await seedMember()
    await seedUser(5, "outsider")
    const res = await post(await jwtFor("outsider"), JOHN_6)
    expect(res.status).toBe(403)
  })
})
