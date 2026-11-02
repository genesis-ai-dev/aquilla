// Auth permission matrix gate (sync-worker half).
//
// Why this exists (docs/RELEASE-RISK-GATES.md "Gates"): a PR that touches the
// auth area is held off the hourly release line until a person signs it off.
// This suite is what lets a green PR skip that person. It sends one request
// per (principal × route) through the worker's route handlers against a
// PGlite-seeded two-org fixture and compares every observed status to the
// committed golden (sync-worker/permission-matrix/golden.json). The
// auth-worker half (auth-worker/src/__tests__/permission-matrix.test.ts)
// covers session routes; this half covers what a sync token, an Agent API
// credential (PAT) and the admin bearer can reach here.
//
// A failure here is not a flake and not a fixture to update by reflex: it
// says the candidate build answers an authorization question differently
// from production. If that is the point of the PR, regenerate the golden
// (UPDATE_AUTH_MATRIX=1 pnpm test permission-matrix) and let the golden diff
// be reviewed; the gate workflow keeps the hold on while golden.json changes.
//
// Principals (fixture below): org 1 owns p1 (alice 400, viewer 100, lead 500
// are members); org 2 owns p2 (bob 400). `removed` has a still-valid token for
// p1 and no membership row; `missing_project` has a valid token for a project
// that has no row (the documented fail-open in events/membership.ts — pinned
// here on purpose, see the "membership fail-open" block); `platform` carries
// src:"platform". PATs: unscoped, org-1-scoped, org-2-scoped (cross-org),
// p2-scoped (cross-project), read-only, revoked, and bob's (a user with no
// grant on p1). Admin bearer: right, wrong, none.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// Several handlers reach partyserver (cloudflare:*) through the broadcast path.
vi.mock("partyserver", () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleAdminRequest } from "../admin"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { handleFilesReadRequest } from "../events/files-read-route"
import { handleExportSourceRequest } from "../events/export-route"
import { handleEventsWriteRequest } from "../events/route"
import { checkProjectMembershipDetailed } from "../events/membership"
import { handleExternalReadRequest } from "../external/read-routes"
import { handleExternalOrgReadRequest } from "../external/org-read-routes"
import { handleExternalChangesetsRequest } from "../external/changesets-route"
import { handleExternalExportRequest } from "../external/export-route"
import { handleExternalDiscoveryRequest } from "../external/discovery-route"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { makeTestToken } from "./helpers/auth"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPDATE = process.env.UPDATE_AUTH_MATRIX === "1"
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../permission-matrix/golden.json",
)

const SECRET = "test-secret"
const ADMIN_SECRET = "admin-secret"
const P1 = "p1" // org 1
const P2 = "p2" // org 2
const FILE = "f1"

// ── fixture ─────────────────────────────────────────────────────────────────

const USERS = { alice: 1, bob: 2, removed: 3, viewer: 4, lead: 5, platform: 999 } as const

interface CredentialSpec {
  userId: number
  orgId?: string | null
  projectId?: string | null
  access?: "read" | "write"
  revoked?: boolean
}

const CREDENTIALS: Record<string, CredentialSpec> = {
  pat_unscoped: { userId: USERS.alice },
  pat_org1: { userId: USERS.alice, orgId: "1" },
  pat_org2: { userId: USERS.alice, orgId: "2" },
  pat_project_p2: { userId: USERS.alice, projectId: P2 },
  pat_readonly: { userId: USERS.alice, access: "read" },
  pat_revoked: { userId: USERS.alice, revoked: true },
  pat_bob: { userId: USERS.bob },
}

async function seed(): Promise<{ tdb: TestDb; tokens: Record<string, string> }> {
  const tdb = await makeTestDb({
    organizations: [
      { id: 1, name: "Org One", owner_user_id: USERS.alice },
      { id: 2, name: "Org Two", owner_user_id: USERS.bob },
    ],
    projects: [
      { id: P1, name: "Project One", created_by: USERS.alice, org_id: 1 },
      { id: P2, name: "Project Two", created_by: USERS.bob, org_id: 2 },
    ],
    project_members: [
      { project_id: P1, user_id: USERS.alice, role_level: 400 },
      { project_id: P1, user_id: USERS.viewer, role_level: 100 },
      { project_id: P1, user_id: USERS.lead, role_level: 500 },
      { project_id: P2, user_id: USERS.bob, role_level: 400 },
    ],
    files: [{ id: FILE, project_id: P1, name: "Genesis" }],
    cells: [
      {
        project_id: P1, file_id: FILE, cell_id: "cell-1", side: "source",
        value: "source one", event_id: "src-evt-1", last_edit_at: 1,
      },
    ],
  })
  // The target lane the SetTranslation and export probes name, so an
  // authorized caller reaches 200 and not a validation 400.
  await tdb.pg.query(
    `INSERT INTO lanes (id, project_id, role, legacy_tag, position) VALUES ('deflane1', $1, 'target', '', 1)`,
    [P1],
  )
  for (const [name, id] of Object.entries(USERS)) {
    await tdb.pg.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
      [id, name, `${name}@x.com`],
    )
  }
  const tokens: Record<string, string> = {}
  for (const [name, spec] of Object.entries(CREDENTIALS)) {
    const { token, tokenHash, tokenPrefix } = await mintApiToken()
    await tdb.pg.query(
      `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id, access, revoked_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'act', $5, $6, $7, $8)`,
      [
        String(spec.userId),
        name,
        tokenPrefix,
        tokenHash,
        spec.orgId ?? null,
        spec.projectId ?? null,
        spec.access ?? "write",
        spec.revoked ? new Date().toISOString() : null,
      ],
    )
    tokens[name] = token
  }
  return { tdb, tokens }
}

// ── principals ──────────────────────────────────────────────────────────────

type Principal =
  | "anonymous"
  | "token_contributor"
  | "token_viewer"
  | "token_lead"
  | "token_platform"
  | "token_other_project"
  | "token_removed_member"
  | "token_missing_project"
  | "token_expired"
  | "token_wrong_secret"
  | keyof typeof CREDENTIALS
  | "admin_bearer"
  | "admin_wrong_bearer"

const PRINCIPALS: Principal[] = [
  "anonymous",
  "token_contributor",
  "token_viewer",
  "token_lead",
  "token_platform",
  "token_other_project",
  "token_removed_member",
  "token_missing_project",
  "token_expired",
  "token_wrong_secret",
  ...(Object.keys(CREDENTIALS) as Array<keyof typeof CREDENTIALS>),
  "admin_bearer",
  "admin_wrong_bearer",
]

const now = () => Math.floor(Date.now() / 1000)

async function bearerFor(principal: Principal, tokens: Record<string, string>): Promise<string | null> {
  const t = (over: Record<string, unknown>, secret = SECRET) =>
    makeTestToken(secret, { projectId: P1, fileId: FILE, ...over } as never)
  switch (principal) {
    case "anonymous":
      return null
    case "token_contributor":
      return t({ userId: USERS.alice, username: "alice", role: 400 })
    case "token_viewer":
      return t({ userId: USERS.viewer, username: "viewer", role: 100 })
    case "token_lead":
      return t({ userId: USERS.lead, username: "lead", role: 500 })
    case "token_platform":
      return t({ userId: USERS.platform, username: "platform", role: 700, src: "platform" })
    case "token_other_project":
      return t({ userId: USERS.bob, username: "bob", role: 400, projectId: P2 })
    case "token_removed_member":
      return t({ userId: USERS.removed, username: "removed", role: 400 })
    case "token_missing_project":
      return t({ userId: USERS.alice, username: "alice", role: 400, projectId: "p_missing" })
    case "token_expired":
      return t({ userId: USERS.alice, username: "alice", role: 400, iat: now() - 120, exp: now() - 60 })
    case "token_wrong_secret":
      return t({ userId: USERS.alice, username: "alice", role: 400 }, "not-the-secret")
    case "admin_bearer":
      return ADMIN_SECRET
    case "admin_wrong_bearer":
      return "nope"
    default:
      return tokens[principal]
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

interface Probe {
  method: "GET" | "POST"
  path: string
  body?: unknown
  /** Reduce a 2xx body to the part that says WHOSE data came back. */
  digest?: (json: unknown) => string
}

/** The project the token principals above are minted for; the missing-project
 *  token probes `p_missing` instead so its rows exercise the fail-open. */
const projectFor = (principal: Principal): string =>
  principal === "token_missing_project" ? "p_missing" : P1

const idsDigest = (json: unknown): string => {
  const data = (json as { data?: Array<{ id?: string; projectId?: string }> })?.data ?? []
  return `ids=${data.map((d) => d.id ?? d.projectId ?? "?").sort().join(",")}`
}

function newCellEvent(projectId: string, author: string): unknown {
  return {
    id: `evt-${projectId}-${author}-${Math.random().toString(36).slice(2, 10)}`,
    schemaVersion: 1,
    kind: "target.cell.create",
    projectId,
    fileId: FILE,
    cellId: `cell-${author}`,
    parentId: null,
    author,
    payload: { cellId: `cell-${author}`, value: "hello" },
    clientTs: 100,
  }
}

function probes(principal: Principal): Probe[] {
  const p = projectFor(principal)
  const author = principal
  return [
    // Session-token (sync) surface.
    { method: "GET", path: `/api/v1/projects/${p}/files` },
    { method: "GET", path: `/api/v1/projects/${p}/files/${FILE}/cells` },
    { method: "GET", path: `/api/v1/projects/${p}/files/${FILE}/source` },
    { method: "POST", path: "/events", body: { events: [newCellEvent(p, author)] } },
    // Agent API (PAT) surface.
    { method: "GET", path: "/api/v1/external/me" },
    { method: "GET", path: "/api/v1/external/projects", digest: idsDigest },
    { method: "GET", path: "/api/v1/external/orgs", digest: idsDigest },
    { method: "GET", path: "/api/v1/external/orgs/1/projects", digest: idsDigest },
    { method: "GET", path: "/api/v1/external/orgs/2/projects", digest: idsDigest },
    { method: "GET", path: `/api/v1/external/projects/${P1}` },
    { method: "GET", path: `/api/v1/external/projects/${P2}` },
    { method: "GET", path: `/api/v1/external/projects/${P1}/files` },
    { method: "GET", path: `/api/v1/external/projects/${P1}/files/${FILE}/export?lane=deflane1` },
    {
      method: "POST",
      path: `/api/v1/external/projects/${P1}/changesets`,
      body: { commands: [{ kind: "SetTranslation", fileId: FILE, cellId: "cell-1", laneId: "deflane1", value: "hello" }] },
    },
    {
      method: "POST",
      path: `/api/v1/external/projects/${P2}/changesets`,
      body: { commands: [{ kind: "SetTranslation", fileId: FILE, cellId: "cell-1", laneId: "deflane1", value: "hello" }] },
    },
    // Admin surface.
    { method: "GET", path: `/admin/files/${P1}/${FILE}/inspect` },
  ]
}

// ── dispatch ────────────────────────────────────────────────────────────────

/** The SNAPSHOTS bucket as the admin inspect + export routes see it: empty. */
const emptyBucket = {
  list: async () => ({ objects: [], truncated: false, cursor: undefined }),
  get: async () => null,
  head: async () => null,
} as unknown as R2Bucket

function makeEnv(tdb: TestDb) {
  return {
    AQUILLA_PG: tdb.db,
    SYNC_SECRET_KEY: SECRET,
    ADMIN_SECRET,
    SNAPSHOTS: emptyBucket,
    BASE_URL: "https://aquilla.app",
  }
}

type Env = ReturnType<typeof makeEnv>

/** The handlers in the order sync-worker/src/index.ts dispatches them. */
async function dispatch(request: Request, env: Env): Promise<Response> {
  const chain: Array<(r: Request) => Promise<Response | null>> = [
    (r) => handleAdminRequest(r, env as never),
    (r) => handleFilesReadRequest(r, env),
    (r) => handleCellsReadRequest(r, env),
    (r) => handleExportSourceRequest(r, env),
    (r) => handleExternalReadRequest(r, env),
    (r) => handleExternalOrgReadRequest(r, env),
    (r) => handleExternalExportRequest(r, env),
    (r) => handleEventsWriteRequest(r, env),
    (r) => handleExternalChangesetsRequest(r, env),
    async (r) => handleExternalDiscoveryRequest(r),
  ]
  for (const handler of chain) {
    const res = await handler(request.clone())
    if (res) return res
  }
  return new Response("not found", { status: 404 })
}

async function send(principal: Principal, probe: Probe, env: Env, tokens: Record<string, string>): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const bearer = await bearerFor(principal, tokens)
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`
  const res = await dispatch(
    new Request(`https://worker${probe.path}`, {
      method: probe.method,
      headers,
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
    }),
    env,
  )
  if (probe.path === "/events" && res.status === 200) {
    // The write perimeter answers 200 for the batch and says per event
    // whether it applied. Which one it was is the authorization answer.
    const body = (await res.json()) as { accepted?: unknown[]; rejected?: Array<{ reason?: string; status?: number }> }
    if (body.rejected?.length) return `200 rejected:${body.rejected[0].status ?? body.rejected[0].reason ?? "?"}`
    return `200 accepted`
  }
  if (res.status < 300 && probe.digest) {
    let json: unknown = null
    try {
      json = JSON.parse(await res.text())
    } catch {
      /* non-JSON 2xx: status alone */
    }
    return `${res.status} ${probe.digest(json)}`
  }
  return String(res.status)
}

const rowKey = (principal: Principal, probe: Probe): string => `${principal} ${probe.method} ${probe.path}`

// ── golden ──────────────────────────────────────────────────────────────────

type Golden = Record<string, string>

function readGolden(): Golden {
  if (!existsSync(GOLDEN_PATH)) {
    if (UPDATE) return {}
    throw new Error(`${GOLDEN_PATH} missing; run UPDATE_AUTH_MATRIX=1 to create it`)
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden
}

const golden = readGolden()
const observed: Golden = {}

let tdb: TestDb
let tokens: Record<string, string>
beforeAll(async () => {
  ;({ tdb, tokens } = await seed())
})

describe("auth permission matrix gate (sync-worker)", () => {
  it("probes every guarded route family, so the gate can never pass vacuously", () => {
    const paths = probes("token_contributor").map((p) => `${p.method} ${p.path}`)
    for (const f of ["/api/v1/projects/", "POST /events", "/external/me", "/external/orgs", "/changesets", "/export", "/admin/"]) {
      expect(paths.some((p) => p.includes(f)), f).toBe(true)
    }
    expect(PRINCIPALS).toContain("pat_org2") // the cross-org PAT
    expect(PRINCIPALS).toContain("token_removed_member")
  })

  // The sanity rows a reader checks first, in words, so a golden regenerated
  // over a regression still fails review.
  it("pins the invariants the forbidden outcome is about", async () => {
    const env = makeEnv(tdb)
    const read = (path: string): Probe => ({ method: "GET", path })
    expect(await send("anonymous", read(`/api/v1/projects/${P1}/files`), env, tokens)).toBe("401")
    expect(await send("token_other_project", read(`/api/v1/projects/${P1}/files`), env, tokens)).toBe("403")
    expect(await send("pat_bob", read(`/api/v1/external/projects/${P1}`), env, tokens)).toBe("403")
    expect(await send("pat_org2", read(`/api/v1/external/projects/${P1}`), env, tokens)).toBe("403")
    expect(await send("pat_project_p2", read(`/api/v1/external/projects/${P1}`), env, tokens)).toBe("403")
    expect(await send("pat_revoked", read("/api/v1/external/me"), env, tokens)).toBe("401")
    expect(await send("admin_wrong_bearer", read(`/admin/files/${P1}/${FILE}/inspect`), env, tokens)).toBe("401")
    // A removed member's still-valid token writes nothing (AQU-346), while a
    // read stays open until the token's 15-minute TTL — the documented window.
    expect(
      await send("token_removed_member", { method: "POST", path: "/events", body: { events: [newCellEvent(P1, "removed")] } }, env, tokens),
    ).toMatch(/^200 rejected:/)
    expect(await send("token_removed_member", read(`/api/v1/projects/${P1}/files`), env, tokens)).toBe("200")
  })

  it.each(PRINCIPALS)("%s: every route answers as the golden says", async (principal) => {
    const env = makeEnv(tdb)
    const diffs: string[] = []
    for (const probe of probes(principal)) {
      const key = rowKey(principal, probe)
      const value = await send(principal, probe, env, tokens)
      observed[key] = value
      if (UPDATE) continue
      if (!(key in golden)) diffs.push(`${key}: not in golden (observed ${value})`)
      else if (golden[key] !== value) diffs.push(`${key}: golden ${golden[key]} → observed ${value}`)
    }
    if (diffs.length) {
      throw new Error(
        `${diffs.length} permission answer(s) differ from permission-matrix/golden.json\n  ${diffs.join("\n  ")}\n` +
          "If the change is intended, run UPDATE_AUTH_MATRIX=1 and have the golden diff reviewed.",
      )
    }
  })

  it("has no golden row the matrix no longer produces", () => {
    if (UPDATE) return
    const stale = Object.keys(golden).filter((k) => !(k in observed) && !k.startsWith("membership-fail-open "))
    expect(stale).toEqual([])
  })
})

// events/membership.ts fails OPEN in two cases (its header comment): a
// project with no row, and a thrown query. Decision (RELEASE-RISK-GATES.md
// "Gates", auth matrix): keep both, pinned here so the behaviour is a reviewed
// golden row rather than a silent property.
//   - Missing row: the sync-token route 403s an unknown projectId (AQU-299),
//     so no live token exists for a project without a row; closing it would
//     only break fixtures. The `token_missing_project POST /events` row above
//     is the HTTP face of the same decision.
//   - Thrown query: enforcement degrades to the 15-minute token TTL instead of
//     500ing every write during a partial outage.
// A PR that changes either flips a golden row and goes to a person.
describe("membership fail-open (pinned)", () => {
  it("records both fail-open answers in the golden", async () => {
    const missing = await checkProjectMembershipDetailed(tdb.db, "p_missing", USERS.alice)
    const throwing = {
      prepare: () => {
        throw new Error("db unavailable")
      },
    } as unknown as AquillaDb
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errored = await checkProjectMembershipDetailed(throwing, P1, USERS.alice)
    warn.mockRestore()
    const rows: Golden = {
      "membership-fail-open missing-project-row": `${missing.status} role=${missing.roleLevel}`,
      "membership-fail-open query-throws": `${errored.status} role=${errored.roleLevel}`,
    }
    Object.assign(observed, rows)
    if (UPDATE) return
    for (const [key, value] of Object.entries(rows)) expect(golden[key], key).toBe(value)
  })
})

afterAll(async () => {
  await tdb?.close()
  if (!UPDATE) return
  const ordered: Golden = {}
  for (const key of Object.keys(observed).sort()) ordered[key] = observed[key]
  mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true })
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(ordered, null, 2)}\n`)
})
