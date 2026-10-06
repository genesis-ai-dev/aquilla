// AQU-1691 — answering a fact question over HTTP.
//
// WHY: answering a card now writes a durable project fact, so the route must
// hold the same lines as Settings. An answer that changes the Language profile
// needs the role that may change the profile (maintainer); a contributor's
// attempt must change nothing. An answer the fact cannot hold must come back
// as a reason code the card can explain, with the card still open. And the
// list must carry what the card needs to answer in one click.

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { getDecision } from "../../../db/shared/contextual-decisions"
import { readSettingsBlob } from "../../../db/shared/project-facts-write"
import { raiseFactQuestion } from "../lib/contextual/fact-questions"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const db = env.AQUILLA_PG
let userSeq = 500

async function member(projectId: string, level: number): Promise<string> {
  const userId = ++userSeq
  const username = `member-${userId}`
  await seedUser(userId, username)
  await db
    .prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)")
    .bind(projectId, userId, level, userId)
    .run()
  return jwtFor(username)
}

/** A project owned by a separate user, so members resolve to exactly their own level. */
async function project(): Promise<{ id: string; contributor: string; maintainer: string }> {
  const id = `proj-fact-routes-${++userSeq}`
  const ownerId = ++userSeq
  await seedUser(ownerId, `owner-${ownerId}`)
  await db.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)").bind(id, id, ownerId).run()
  return { id, contributor: await member(id, 400), maintainer: await member(id, 600) }
}

function answer(projectId: string, decisionId: string, jwt: string, text: string): Promise<Response> {
  return app.request(
    `/api/v2/projects/${projectId}/contextual/decisions/${decisionId}/answer`,
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ answer: text }) },
    env,
  )
}

async function ask(projectId: string, factKey: string, options: string[]) {
  const raised = await raiseFactQuestion(db, {
    projectId,
    factKey,
    reason: `Which value for ${factKey}?`,
    options: options.map((value) => ({ value })),
  })
  if (raised.status !== "raised") throw new Error(`not raised: ${raised.status}`)
  return raised.decision
}

describe("answering a fact question", () => {
  it("lists the question with its key and options and no file, so the card can answer in one click", async () => {
    const p = await project()
    const question = await ask(p.id, "render.the-twelve", ["the Twelve", "the twelve apostles"])
    const res = await app.request(`/api/v2/projects/${p.id}/contextual/decisions`, { headers: authHeader(p.contributor) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { decisions: Record<string, unknown>[] }
    expect(body.decisions).toEqual([
      expect.objectContaining({
        id: question.id,
        fileId: null,
        readinessItem: "bible-fact",
        factKey: "render.the-twelve",
        options: [{ value: "the Twelve" }, { value: "the twelve apostles" }],
      }),
    ])
  })

  it("lets a contributor record a decision-log fact", async () => {
    const p = await project()
    const question = await ask(p.id, "render.the-twelve", ["the Twelve", "the twelve apostles"])
    const res = await answer(p.id, question.id, p.contributor, "the Twelve")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ factRecorded: "fact" })
    expect((await readSettingsBlob(db, p.id)).projectFacts).toMatchObject([{ key: "render.the-twelve", value: "the Twelve" }])
  })

  it("refuses a contributor's answer that would change the Language profile, and changes nothing", async () => {
    const p = await project()
    const question = await ask(p.id, "measures", ["convert", "transliterate"])
    const res = await answer(p.id, question.id, p.contributor, "convert")
    expect(res.status).toBe(403)
    expect((await getDecision(db, question.id))?.status).toBe("open")
    expect((await readSettingsBlob(db, p.id)).languageProfile).toBeUndefined()

    const byMaintainer = await answer(p.id, question.id, p.maintainer, "convert")
    expect(byMaintainer.status).toBe(200)
    expect(await byMaintainer.json()).toMatchObject({ factRecorded: "profile" })
    expect((await readSettingsBlob(db, p.id)).languageProfile).toEqual({ measures: "convert" })
  })

  it("answers 400 with a reason code, and keeps the card open, when the profile slot cannot hold the answer", async () => {
    const p = await project()
    const question = await ask(p.id, "measures", ["convert", "transliterate"])
    const res = await answer(p.id, question.id, p.maintainer, "metric")
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: "validation_failed", details: { reason: "profile-value-invalid" } },
    })
    expect((await getDecision(db, question.id))?.status).toBe("open")
  })
})
