// Trigger feeds for polling integrations (Zapier plan, workstream B).
//
// A Zapier polling trigger re-reads page 1 every few minutes and dedupes on
// `id`. What breaks it is not a field changing shape, it is:
//   - a cursor that repeats or skips an event when new ones land between calls
//     (a repeated zap run sends a duplicate email; a skipped one loses a comment),
//   - a feed that leaks who did what into a third-party service the project
//     never opted into (AQU-1180), or replication noise that fires zaps for
//     nothing,
//   - an approval queue a viewer can read, when only maintainers can act on it.
// Each test below encodes one of those.

import { describe, it, expect, beforeEach } from "vitest"
import { handleExternalReadRequest } from "../external/read-routes"
import { ACTIVITY_SCAN_WINDOW } from "../external/activity-route"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"
const HUMAN = "anastasiia"
const MAINT = "maxmaint"
const VIEWER = "vikaview"

let credSeq = 0
async function seedCredential(
  testDb: TestDb,
  opts: { userId: number; pii?: boolean },
): Promise<{ token: string; id: string }> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const id = `00000000-0000-0000-0000-${String(++credSeq).padStart(12, "0")}`
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, project_id, pii)
     VALUES ($1, $2, 'test', $3, $4, 'act', 'proj-a', $5)`,
    [id, String(opts.userId), tokenPrefix, tokenHash, opts.pii === true],
  )
  return { token, id }
}

async function seed(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES
       (1, $1, 'a@x.com', 'h'), (2, $2, 'm@x.com', 'h'), (3, $3, 'v@x.com', 'h')`,
    [HUMAN, MAINT, VIEWER],
  )
  await testDb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`)
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'Project A', 10, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-a', 2, 600), ('proj-a', 3, 100)`,
  )
}

async function insertEvent(
  testDb: TestDb,
  e: { seq: number; kind: string; author?: string; payload?: unknown; fileId?: string; cellId?: string },
) {
  await testDb.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES ($1, 1, 'proj-a', $2, $3, $4, $5, $6, $7, $7, NULL, $7)`,
    [
      `evt-${e.seq}`,
      e.fileId ?? "file-x",
      e.cellId ?? null,
      e.kind,
      e.author ?? "importer",
      JSON.stringify(e.payload ?? {}),
      e.seq,
    ],
  )
}

function env(testDb: TestDb, extra: Record<string, string> = {}) {
  return { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET, BASE_URL: "https://app.test", ...extra }
}

async function get(testDb: TestDb, path: string, token: string, extra: Record<string, string> = {}) {
  const res = await handleExternalReadRequest(
    new Request(`https://worker${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    env(testDb, extra),
  )
  expect(res).not.toBeNull()
  const raw = await res!.text()
  return { status: res!.status, raw, body: JSON.parse(raw) as Record<string, unknown> }
}

interface ActivityBody {
  items: Array<{ id: string; kind: string; serverSeq: number; author?: string; data: Record<string, unknown> }>
  nextCursor: string | null
}

const ACTIVITY = "/api/v1/external/projects/proj-a/activity"

describe("GET /projects/:pid/activity", () => {
  let testDb: TestDb
  beforeEach(async () => {
    testDb = await makeTestDb()
    await seed(testDb)
  })

  it("never repeats or skips an event when new ones land between polls", async () => {
    for (let seq = 1; seq <= 10; seq++) await insertEvent(testDb, { seq, kind: "target.cell.commit", payload: { value: `v${seq}` } })
    const { token } = await seedCredential(testDb, { userId: 1 })

    const seen: number[] = []
    let page = (await get(testDb, `${ACTIVITY}?limit=4`, token)).body as unknown as ActivityBody
    seen.push(...page.items.map((i) => i.serverSeq))
    expect(seen).toEqual([10, 9, 8, 7])

    // Five new events arrive mid-walk. With an offset cursor these would push
    // the window down and page 2 would re-deliver 7..10.
    for (let seq = 11; seq <= 15; seq++) await insertEvent(testDb, { seq, kind: "target.cell.commit" })

    while (page.nextCursor) {
      page = (await get(testDb, `${ACTIVITY}?limit=4&cursor=${page.nextCursor}`, token)).body as unknown as ActivityBody
      seen.push(...page.items.map((i) => i.serverSeq))
    }
    expect(seen).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])

    // And a poller re-reading page 1 sees the new events first.
    const head = (await get(testDb, `${ACTIVITY}?limit=4`, token)).body as unknown as ActivityBody
    expect(head.items.map((i) => i.serverSeq)).toEqual([15, 14, 13, 12])
  })

  it("bounds one call's scan, yet a rare kind below the window is still reachable by cursor", async () => {
    await insertEvent(testDb, { seq: 1, kind: "comment.create", payload: { commentId: "c1", body: "old" } })
    await testDb.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
       SELECT 'noise-' || g, 1, 'proj-a', 'file-x', NULL, 'target.cell.commit', 'importer', '{}', g, g, NULL, g
         FROM generate_series(2, $1::int) g`,
      [ACTIVITY_SCAN_WINDOW + 2],
    )
    const { token } = await seedCredential(testDb, { userId: 1 })

    const first = (await get(testDb, `${ACTIVITY}?kinds=comment.create`, token)).body as unknown as ActivityBody
    // The comment is older than the 5000 newest events: not scanned this call…
    expect(first.items).toEqual([])
    // …but the cursor points below the window rather than ending the feed.
    expect(first.nextCursor).not.toBeNull()
    const second = (await get(testDb, `${ACTIVITY}?kinds=comment.create&cursor=${first.nextCursor}`, token))
      .body as unknown as ActivityBody
    expect(second.items.map((i) => i.id)).toEqual(["evt-1"])
    expect(second.nextCursor).toBeNull()
  })

  it("never serves replication bookkeeping kinds, even when asked for them", async () => {
    await insertEvent(testDb, { seq: 1, kind: "source.cell.mirror" })
    await insertEvent(testDb, { seq: 2, kind: "file.mirror" })
    await insertEvent(testDb, { seq: 3, kind: "link.cursor.advance" })
    await insertEvent(testDb, { seq: 4, kind: "file.create", payload: { name: "Genesis", fileType: "usfm", r2Key: "secret/key" } })
    const { token } = await seedCredential(testDb, { userId: 1 })

    const all = (await get(testDb, ACTIVITY, token)).body as unknown as ActivityBody
    expect(all.items.map((i) => i.kind)).toEqual(["file.create"])
    // Allowlist, not passthrough: storage keys stay server-side.
    expect(all.items[0]!.data).toEqual({ name: "Genesis", fileType: "usfm" })

    const asked = await get(testDb, `${ACTIVITY}?kinds=source.cell.mirror,link.cursor.advance`, token)
    expect(asked.status).toBe(200)
    expect((asked.body as unknown as ActivityBody).items).toEqual([])
  })

  it("a pii=false credential never sees a username — not in author, not in data", async () => {
    await insertEvent(testDb, {
      seq: 1,
      kind: "comment.create",
      author: HUMAN,
      payload: { commentId: "c1", body: `@[${MAINT}] please check`, parentCommentId: null, scope: { kind: "project" } },
    })
    await insertEvent(testDb, {
      seq: 2,
      kind: "cell.unvalidate",
      author: MAINT,
      payload: { editEventId: "evt-x", targetUsername: HUMAN },
    })
    const { token } = await seedCredential(testDb, { userId: 1 })

    const res = await get(testDb, ACTIVITY, token)
    expect(res.status).toBe(200)
    expect(res.raw).not.toContain(HUMAN)
    expect(res.raw).not.toContain(MAINT)
    const items = (res.body as unknown as ActivityBody).items
    for (const item of items) expect(item.author).toMatch(/^u_[0-9a-f]{8}$/)
    // The mention is pseudonymised with the SAME id the author field uses, so an
    // agent can still tell the comment is addressed to the person who unvalidated.
    const comment = items.find((i) => i.kind === "comment.create")!
    const unvalidate = items.find((i) => i.kind === "cell.unvalidate")!
    expect(comment.data.body).toBe(`@[${unvalidate.author}] please check`)

    // The control: an OWNER-minted pii credential is allowed real names.
    const pii = await seedCredential(testDb, { userId: 1, pii: true })
    const real = await get(testDb, ACTIVITY, pii.token)
    expect(real.raw).toContain(HUMAN)
  })

  it("hides lane-scoped events on lanes a walled member cannot read", async () => {
    await testDb.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag) VALUES
        ('frlane01', 'proj-a', 'target', 'French', 'fr'), ('eslane01', 'proj-a', 'target', 'Spanish', 'es')`,
    )
    await testDb.pg.query(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('proj-a', 3, 'eslane01', 100)`,
    )
    await insertEvent(testDb, { seq: 1, kind: "target.cell.commit", payload: { value: "bonjour", laneId: "frlane01" } })
    await insertEvent(testDb, { seq: 2, kind: "target.cell.commit", payload: { value: "hola", laneId: "eslane01" } })
    const { token } = await seedCredential(testDb, { userId: 3 })

    const res = await get(testDb, ACTIVITY, token, { LANE_READ_WALL: "1" })
    expect(res.raw).not.toContain("bonjour")
    expect((res.body as unknown as ActivityBody).items.map((i) => i.data.value)).toEqual(["hola"])
  })

  it("rejects a cursor it cannot read instead of restarting the walk", async () => {
    const { token } = await seedCredential(testDb, { userId: 1 })
    const res = await get(testDb, `${ACTIVITY}?cursor=not-a-cursor`, token)
    expect(res.status).toBe(400)
  })
})

describe("GET /projects/:pid/changesets/pending", () => {
  let testDb: TestDb
  beforeEach(async () => {
    testDb = await makeTestDb()
    await seed(testDb)
  })

  async function insertChangeset(
    id: string,
    opts: { status?: string; createdAt: string; expiresAt?: string; userId?: number; credentialId?: string },
  ) {
    await testDb.pg.query(
      `INSERT INTO changesets (id, project_id, created_by_user_id, credential_id, autonomy_mode, status,
                               commands, preconditions, summary, digest, created_at, expires_at)
       VALUES ($1, 'proj-a', $2, $3, 'ask', $4, $5, '[]', $6, 'd', $7, $8)`,
      [
        id,
        String(opts.userId ?? 1),
        opts.credentialId ?? "cred-secret-id",
        opts.status ?? "staged",
        JSON.stringify([{ kind: "AddOrgMember", username: "secret-invitee" }]),
        JSON.stringify({ translationsAdded: 3, command: "AddOrgMember", orgMemberUsername: "secret-invitee" }),
        opts.createdAt,
        opts.expiresAt ?? "2999-01-01T00:00:00Z",
      ],
    )
  }

  const PENDING = "/api/v1/external/projects/proj-a/changesets/pending"

  it("refuses a VIEWER: only people who can approve see the queue", async () => {
    await insertChangeset("cs-1", { createdAt: "2026-10-01T00:00:00Z" })
    const { token } = await seedCredential(testDb, { userId: 3 })
    const res = await get(testDb, PENDING, token)
    expect(res.status).toBe(403)
    expect(res.raw).not.toContain("cs-1")
  })

  it("lists every credential's staged, unexpired plans newest first, in a slim DTO", async () => {
    await insertChangeset("cs-old", { createdAt: "2026-10-01T00:00:00Z" })
    await insertChangeset("cs-new", { createdAt: "2026-10-02T00:00:00Z", credentialId: "another-cred" })
    await insertChangeset("cs-done", { createdAt: "2026-10-03T00:00:00Z", status: "committed" })
    await insertChangeset("cs-expired", { createdAt: "2026-10-04T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z" })
    const { token } = await seedCredential(testDb, { userId: 2 })

    const res = await get(testDb, PENDING, token)
    expect(res.status).toBe(200)
    const data = res.body.data as Array<Record<string, unknown>>
    expect(data.map((d) => d.id)).toEqual(["cs-new", "cs-old"])
    expect(Object.keys(data[0]!).sort()).toEqual(["approvalUrl", "author", "createdAt", "id", "summary"])
    expect(data[0]!.approvalUrl).toBe("https://app.test/approve/cs-new")
    expect(data[0]!.summary).toEqual({ translationsAdded: 3, command: "AddOrgMember" })
    expect(data[0]!.author).toMatch(/^u_[0-9a-f]{8}$/)
    // Nothing that identifies a person or a token, and no raw commands.
    for (const leak of [HUMAN, "secret-invitee", "cred-secret-id", "another-cred"]) {
      expect(res.raw).not.toContain(leak)
    }
  })
})

describe("?sort=created", () => {
  let testDb: TestDb
  beforeEach(async () => {
    testDb = await makeTestDb()
    await seed(testDb)
  })

  it("lists projects newest first, so a 'new project' poll sees the new one on page 1", async () => {
    // proj-0 sorts first by name but was created first, so the default order
    // would bury proj-a — the project a poller is waiting for.
    await testDb.pg.query(`UPDATE projects SET created_at = '2026-10-01' WHERE id = 'proj-a'`)
    await testDb.pg.query(
      `INSERT INTO projects (id, name, org_id, created_by, created_at) VALUES ('proj-0', 'AAA first by name', 10, 1, '2026-01-01')`,
    )
    const { token } = await seedCredential(testDb, { userId: 1 })
    // The credential is project-scoped; widen it for the project list.
    await testDb.pg.query(`UPDATE api_credentials SET project_id = NULL`)
    const ids = async (path: string) =>
      ((await get(testDb, path, token)).body.data as Array<{ id: string }>).map((p) => p.id)
    expect(await ids("/api/v1/external/projects")).toEqual(["proj-0", "proj-a"])
    expect(await ids("/api/v1/external/projects?sort=created")).toEqual(["proj-a", "proj-0"])
  })

  it("lists files newest first, regardless of edit recency", async () => {
    await testDb.pg.query(
      `INSERT INTO files (id, project_id, name, event_id, created_at, last_edit_at) VALUES
         ('f-old', 'proj-a', 'Old', 'e1', 1000, 9000),
         ('f-new', 'proj-a', 'New', 'e2', 2000, 1000)`,
    )
    const { token } = await seedCredential(testDb, { userId: 1 })
    const res = await get(testDb, "/api/v1/external/projects/proj-a/files?sort=created", token)
    expect((res.body.data as Array<{ fileId: string }>).map((f) => f.fileId)).toEqual(["f-new", "f-old"])
  })

  it("rejects an unknown sort rather than silently using another order", async () => {
    const { token } = await seedCredential(testDb, { userId: 1 })
    expect((await get(testDb, "/api/v1/external/projects/proj-a/files?sort=newest", token)).status).toBe(400)
  })
})
