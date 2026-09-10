import { handleCorsPreflight, withCors } from "../cors"
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { handleCheckingRequest, type CheckingEnv } from "../checking/route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import { verifyTokenForProject } from "../auth"
import { v7 as uuidv7 } from "uuid"
vi.mock("partyserver", () => ({ getServerByName: vi.fn() }))
const SECRET = "checking-test-secret"
let data: TestDb
let env: CheckingEnv
let ownerToken: string
async function request(path: string, token?: string, body?: unknown) {
  return (await handleCheckingRequest(new Request(`https://sync.test/checking${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env))!
}
async function create(role = "commenter", pin?: string) {
  const response = await request("", ownerToken, { projectId: "p", title: "Community", role,
    units: [{ fileId: "f", cellId: "c1" }], ...(pin ? { pin } : {}) })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json() as { token: string }).token
}
async function join(link: string, pin?: string) {
  const response = await request(`/${link}/join`, undefined, { name: "Kathryn", ...(pin ? { pin } : {}) })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json() as { session: string }).session
}
const event = (cellId = "c1") => ({ id: uuidv7(), schemaVersion: 1, kind: "comment.create", projectId: "p", fileId: "f", cellId,
  parentId: null, author: "forged-author", clientTs: Date.now(), payload: { commentId: uuidv7(),
    scope: { kind: "cell", fileId: "f", cellId }, body: "This is clear", parentCommentId: null } })
beforeAll(async () => {
  data = await makeTestDb({
    users: [{ id: 1, username: "owner", email: "owner@example.test" }],
    projects: [{ id: "p", name: "Pattani", created_by: 1 }],
    files: [{ id: "f", project_id: "p", name: "Mark", event_id: "f-event" }],
    cells: ["c1", "c2"].map((cellId, index) => ({ project_id: "p", file_id: "f", cell_id: cellId,
      side: "source", target_lang: "", value: `Passage ${index + 1}`, canonical_ref: `MRK 1:${index + 1}`, event_id: `${cellId}-event`, last_edit_at: 1 })),
  })
  env = { AQUILLA_PG: data.db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: {} as R2Bucket }
  ownerToken = await makeTestToken(SECRET, { projectId: "p", userId: 1, username: "owner", role: 700 })
})
afterAll(async () => { await data.close() })
describe("checking capabilities", () => {
  it("serves preflight and CORS for every checking surface", () => {
    for (const path of ["", "/" + "a".repeat(64) + "/join", "/" + "a".repeat(64) + "/events", "/" + "a".repeat(64) + "/audio"]) {
      const request = new Request(`https://sync.test/checking${path}`, { method: "OPTIONS" })
      expect(handleCorsPreflight(request)?.status).toBe(204)
      expect(withCors(Response.json({}), request).headers.get("Access-Control-Allow-Origin")).toBe("*")
    }
  })
  it("requires lead access and rejects nonexistent scope", async () => {
    const viewer = await makeTestToken(SECRET, { projectId: "p", userId: 1, role: 100 })
    expect((await request("", viewer, { projectId: "p", title: "X", role: "viewer", units: [{ fileId: "f", cellId: "c1" }] })).status).toBe(403)
    expect((await request("", ownerToken, { projectId: "p", title: "X", role: "viewer", units: [{ fileId: "f", cellId: "foreign" }] })).status).toBe(400)
  })
  it("mints a guest-only session, reveals only selected content, and persists attributed feedback idempotently", async () => {
    const link = await create()
    expect((await request(`/${link}/join`, undefined, { name: "   " })).status).toBe(400)
    const session = await join(link)
    expect((await verifyTokenForProject(session, "p", SECRET)).ok).toBe(false)
    const content = await request(`/${link}/content`, session)
    const body = await content.json() as { rows: Array<{ cellId: string }> }
    expect(body.rows.map(row => row.cellId)).toEqual(["c1"])
    expect((await request(`/${link}/events`, session, event("c2"))).status).toBe(401)
    expect((await request(`/${link}/audio?fileId=f&cellId=c2&audioId=foreign`, session)).status).toBe(401)
    const feedback = event()
    const saved = await request(`/${link}/events`, session, feedback)
    expect(saved.status, await saved.clone().text()).toBe(200)
    expect(await saved.json()).toMatchObject({ accepted: [{ id: feedback.id }], rejected: [] })
    await request(`/${link}/events`, session, feedback)
    const comments = await data.rows<{ body: string; author_label: string; cell_id: string }>("comments")
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({ body: "This is clear", cell_id: "c1" })
    expect(comments[0].author_label).toMatch(/^Kathryn \(guest /)
    expect((await request(`/${link}/events`, session, { ...event(), kind: "source.cell.commit" })).status).toBe(400)
  })
  it("stops existing guests when the project freezes, and bounds join attempts", async () => {
    const link = await create()
    const session = await join(link)
    await data.db.prepare("UPDATE projects SET is_active = FALSE WHERE id = 'p'").run()
    expect((await request(`/${link}/content`, session)).status).toBe(401)
    await data.db.prepare("UPDATE projects SET is_active = TRUE WHERE id = 'p'").run()
    await data.db.prepare("UPDATE checking_links SET join_count = 50, join_window = ? WHERE token = ?")
      .bind(Math.floor(Date.now() / (15 * 60_000)), link).run()
    expect((await request(`/${link}/join`, undefined, { name: "Kathryn" })).status).toBe(429)
  })
  it("enforces viewer access, PIN, expiry, and revocation against existing sessions", async () => {
    const link = await create("viewer", "1234")
    expect((await request(`/${link}/join`, undefined, { name: "Kathryn", pin: "9999" })).status).toBe(401)
    const session = await join(link, "1234")
    expect((await request(`/${link}/events`, session, event())).status).toBe(403)
    expect((await request(`/${link}/revoke`, ownerToken, {})).status).toBe(200)
    expect((await request(`/${link}/content`, session)).status).toBe(401)
    const expired = await create()
    await data.db.prepare("UPDATE checking_links SET expires_at = 1 WHERE token = ?").bind(expired).run()
    expect((await request(`/${expired}/join`, undefined, { name: "Kathryn" })).status).toBe(401)
  })
})
