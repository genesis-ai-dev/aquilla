// AQU-1573: the SPA's reference Bible routes. The Settings card lists the
// installed Bibles from GET /, and the copilot's drafting block and the live
// quote check read verses through POST /:versionId/passages — so a wrong
// verse, a silently dropped reference or an uncapped request here shows up as
// a wrong quotation in a sermon.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { installFixtureReferenceBibles } from "../../../db/shared/reference-bible-fixtures"

async function signedIn(): Promise<string> {
  await seedUser(1, "reader")
  return jwtFor("reader")
}

async function list(jwt?: string): Promise<Response> {
  return app.request("/api/v2/reference-bibles", { headers: jwt ? authHeader(jwt) : {} }, env)
}

async function passages(versionId: string, body: unknown, jwt?: string): Promise<Response> {
  return app.request(
    `/api/v2/reference-bibles/${encodeURIComponent(versionId)}/passages`,
    {
      method: "POST",
      headers: jwt ? authHeader(jwt) : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe("GET /api/v2/reference-bibles", () => {
  it("needs a signed-in user", async () => {
    expect((await list()).status).toBe(401)
  })

  it("lists the installed Bibles to any signed-in user, no project needed", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG)
    const res = await list(await signedIn())
    expect(res.status).toBe(200)
    const { versions } = (await res.json()) as { versions: { id: string; name: string; languageName: string }[] }
    expect(versions.map((v) => v.id)).toEqual(["arb-vandyck", "eng-kjv"])
    expect(versions[0]).toMatchObject({ name: "Van Dyck", languageName: "Arabic" })
  })

  it("lists none on a server where the texts were never loaded", async () => {
    const res = await list(await signedIn())
    expect(((await res.json()) as { versions: unknown[] }).versions).toEqual([])
  })
})

describe("POST /api/v2/reference-bibles/:versionId/passages", () => {
  it("returns each reference's verses in that Bible, and the ones it lacks", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG)
    const jwt = await signedIn()
    const res = await passages("arb-vandyck", { refs: ["ISA 40:25", "JHN 3:16-17", "ISA 40:99", "not a ref"] }, jwt)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: { id: string }
      passages: { canonical: string; label: string; verses: { chapter: number; verse: number; text: string }[] }[]
      unresolved: string[]
    }
    expect(body.version.id).toBe("arb-vandyck")
    expect(body.passages.map((p) => p.canonical)).toEqual(["ISA 40:25", "JHN 3:16-17"])
    expect(body.passages[0].label).toBe("Isaiah 40:25")
    // The vowelled Van Dyck wording, verbatim (as stored, marks and all).
    expect(body.passages[0].verses[0].text.startsWith("«فَبِمَنْ ")).toBe(true)
    expect(body.passages[0].verses[0].text).toContain("» يَقُولُ ")
    expect(body.passages[1].verses.map((v) => v.verse)).toEqual([16, 17])
    expect(body.unresolved).toEqual(["not a ref", "ISA 40:99"])
  })

  it("answers from the Bible asked for (KJV wording for the same verse)", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG)
    const res = await passages("eng-kjv", { refs: ["JHN 3:16"] }, await signedIn())
    const body = (await res.json()) as { passages: { verses: { text: string }[] }[] }
    expect(body.passages[0].verses[0].text).toMatch(/^For God so loved the world/)
  })

  it("404 for a Bible that is not installed", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG, ["eng-kjv"])
    const res = await passages("arb-vandyck", { refs: ["ISA 40:25"] }, await signedIn())
    expect(res.status).toBe(404)
  })

  it("400 for a malformed body or more references than one lookup allows", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG)
    const jwt = await signedIn()
    expect((await passages("eng-kjv", { refs: "JHN 3:16" }, jwt)).status).toBe(400)
    const tooMany = Array.from({ length: 201 }, (_, i) => `PSA 23:${(i % 6) + 1}`)
    expect((await passages("eng-kjv", { refs: tooMany }, jwt)).status).toBe(400)
  })

  it("needs a signed-in user", async () => {
    await installFixtureReferenceBibles(env.AQUILLA_PG)
    expect((await passages("eng-kjv", { refs: ["JHN 3:16"] })).status).toBe(401)
  })
})
