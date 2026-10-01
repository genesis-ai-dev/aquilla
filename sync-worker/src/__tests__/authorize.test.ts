import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { authorize, AuthorizedEvent, isAuthorizedEvent, PROJECT_SENTINEL_FILE_ID } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import type { RawEvent } from "../events/types"
import type { SyncTokenClaims } from "../auth"

/**
 * AQU-496: minimal AquillaDb stub for the self-assign carve-out — mirrors
 * export-floor.test.ts's makeDb pattern (project -> org_id -> org_settings).
 */
function makeDb(options: {
  orgId?: number | null
  allowSelfAssignment?: boolean
  /** AQU-581: the lane-delegate carve-out's org setting. */
  allowScopedLaneAssignment?: boolean
  assignmentMinRole?: number
  /** AQU-581 review: the assignee's direct role on the project (null = none). */
  assigneeRoleLevel?: number | null
  /** AQU-581 review: the assignee's own lane/file scopes. */
  assigneeScopes?: { kind: "lane" | "file"; value: string }[]
  /** AQU-581 review: the stored assignment a delegate's unassign targets. */
  assignmentRow?: { created_by: number; target_lang: string; unassigned_at: number | null } | null
  assignmentFiles?: string[]
  /** AQU-1462: target lane rows. Empty means no archived lane. */
  lanes?: { id: string; name: string; legacy_tag: string | null; archived_at: string | null }[]
  /** AQU-1462: parsed project_settings.settings. Null means no row. */
  projectSettings?: Record<string, unknown> | null
  /** AQU-1462: rows from project_member_lane_roles, for an external token. */
  laneRoleRows?: { lane: string; role_level: number }[]
}): AquillaDb {
  const {
    orgId = 1,
    allowSelfAssignment = false,
    allowScopedLaneAssignment = false,
    assignmentMinRole,
    assigneeRoleLevel = 400,
    assigneeScopes = [],
    assignmentRow = null,
    assignmentFiles = ["file-x"],
    lanes = [],
    projectSettings = null,
    laneRoleRows = [],
  } = options
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM project_members")) {
                return assigneeRoleLevel == null ? null : { role_level: assigneeRoleLevel }
              }
              if (sql.includes("FROM assignments")) return assignmentRow
              if (sql.includes("FROM project_settings")) {
                return projectSettings == null ? null : { settings: JSON.stringify(projectSettings) }
              }
              if (sql.includes("FROM projects")) return { org_id: orgId, created_by: 999, archived_at: null }
              if (sql.includes("FROM org_settings")) {
                return {
                  settings: JSON.stringify({
                    allowSelfAssignment,
                    allowScopedLaneAssignment,
                    ...(assignmentMinRole !== undefined ? { assignmentMinRole } : {}),
                  }),
                }
              }
              return null
            },
            async all() {
              if (sql.includes("FROM project_member_scopes")) return { results: assigneeScopes }
              if (sql.includes("FROM assignment_cells")) {
                return { results: assignmentFiles.map((file_id) => ({ file_id })) }
              }
              if (sql.includes("FROM project_member_lane_roles")) return { results: laneRoleRows }
              if (sql.includes("FROM lanes")) {
                return {
                  results: lanes.map((lane) => ({
                    id: lane.id,
                    role: "target",
                    name: lane.name,
                    lang_code: null,
                    legacy_tag: lane.legacy_tag,
                    position: 0,
                    archived_at: lane.archived_at,
                  })),
                }
              }
              return { results: [] }
            },
          }
        },
      }
    },
  } as unknown as AquillaDb
}

function makeAssignmentCreate(
  overrides: Partial<RawEvent<"assignment.create">> = {},
): RawEvent<"assignment.create"> {
  return {
    id: "00000000-0000-7000-0000-000000000003",
    schemaVersion: 1,
    kind: "assignment.create",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: undefined,
    parentId: null,
    author: "alice",
    payload: {
      assignmentId: "asg-1",
      scopeKind: "books",
      scope: [{ fileId: "file-x" }],
      scopeLabel: "Genesis",
      assigneeUserId: 1,
    },
    clientTs: Date.now(),
    ...overrides,
  }
}

const SECRET = "test-secret"

async function makeToken(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  return makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x", ...partial })
}

function makeTargetCommit(overrides: Partial<RawEvent<"target.cell.commit">> = {}): RawEvent<"target.cell.commit"> {
  return {
    id: "00000000-0000-7000-0000-000000000001",
    schemaVersion: 1,
    kind: "target.cell.commit",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: "00000000-0000-7000-0000-000000000000",
    author: "alice",
    payload: { value: "hello", valueHtml: "<p>hello</p>" },
    clientTs: Date.now(),
    ...overrides,
  }
}

function makeSourceCommit(overrides: Partial<RawEvent<"source.cell.commit">> = {}): RawEvent<"source.cell.commit"> {
  return {
    id: "00000000-0000-7000-0000-000000000002",
    schemaVersion: 1,
    kind: "source.cell.commit",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: "00000000-0000-7000-0000-000000000000",
    author: "import-bot",
    payload: { value: "hello", valueHtml: "<p>hello</p>" },
    clientTs: Date.now(),
    ...overrides,
  }
}

describe("authorize()", () => {
  it("returns 401 for missing token", async () => {
    const raw = makeTargetCommit()
    const result = await authorize(null, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("returns 401 for invalid signature", async () => {
    const ts = Math.floor(Date.now() / 1000)
    const wrongToken = await sign(
      { userId: 1, projectId: "proj-a", fileId: "file-x", role: 400, aud: "sync", iat: ts, exp: ts + 900 } as Record<string, unknown>,
      "wrong-secret",
      "HS256",
    )
    const raw = makeTargetCommit()
    const result = await authorize(wrongToken, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("returns 401 for wrong audience", async () => {
    const ts = Math.floor(Date.now() / 1000)
    const token = await sign(
      { userId: 1, projectId: "proj-a", fileId: "file-x", role: 400, aud: "frontier", iat: ts, exp: ts + 900 } as Record<string, unknown>,
      SECRET,
      "HS256",
    )
    const raw = makeTargetCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.reason).toContain("audience")
    }
  })

  it("returns 403 for project mismatch", async () => {
    const token = await makeToken({ projectId: "proj-b" })
    const raw = makeTargetCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("returns 403 for file mismatch", async () => {
    const token = await makeToken({ fileId: "file-y" })
    const raw = makeTargetCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("returns 403 when CONTRIBUTOR tries to source.cell.commit (PROJECT_LEAD only)", async () => {
    const token = await makeToken({ role: 400 })
    const raw = makeSourceCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toContain("source.cell.commit")
    }
  })

  it("returns 403 when COMMENTER tries to target.cell.commit (CONTRIBUTOR only)", async () => {
    const token = await makeToken({ role: 200 })
    const raw = makeTargetCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toContain("target.cell.commit")
    }
  })

  it("returns 400 for missing fileId on event", async () => {
    const token = await makeToken()
    const raw: RawEvent<"target.cell.commit"> = {
      ...makeTargetCommit(),
      fileId: undefined,
    }
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.reason).toContain("fileId")
    }
  })

  it("returns 500 for missing secret", async () => {
    const token = await makeToken()
    const raw = makeTargetCommit()
    const result = await authorize(token, raw, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(500)
  })

  it("returns 500 (not 400) when both secret and fileId are missing — spec ordering", async () => {
    const token = await makeToken()
    const raw: RawEvent<"target.cell.commit"> = {
      ...makeTargetCommit(),
      fileId: undefined,
    }
    const result = await authorize(token, raw, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(500)
    }
  })

  it("returns AuthorizedEvent for a CONTRIBUTOR target commit", async () => {
    const token = await makeToken({ role: 400 })
    const raw = makeTargetCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event).toBeInstanceOf(AuthorizedEvent)
      expect(result.event.claims.roleLevel).toBe(400)
      expect(result.event.claims.userId).toBe(1)
      expect(result.event.claims.username).toBe("alice")
      expect(result.event.claims.projectId).toBe("proj-a")
      expect(result.event.claims.fileId).toBe("file-x")
      expect(result.event.event).toBe(raw)
    }
  })

  it("returns AuthorizedEvent for a PROJECT_LEAD source commit", async () => {
    const token = await makeToken({ role: 500 })
    const raw = makeSourceCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.claims.roleLevel).toBe(500)
    }
  })

  it("uses the token username instead of the client-supplied author", async () => {
    const token = await makeToken({ role: 400, username: "token-alice" })
    const raw = makeTargetCommit({ author: "mallory" })
    const result = await authorize(token, raw, SECRET)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.claims.username).toBe("token-alice")
    }
  })

  it("falls back to user:id when an older sync token has no username claim", async () => {
    const token = await makeToken({ role: 400, username: undefined })
    const raw = makeTargetCommit({ author: "mallory" })
    const result = await authorize(token, raw, SECRET)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.claims.username).toBe("user:1")
    }
  })

  it("Object.assign produces a non-instanceof plain-object copy", async () => {
    const token = await makeToken({ role: 400 })
    const raw = makeTargetCommit()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const real = result.event
      const fake = Object.assign({}, real)
      expect(fake instanceof AuthorizedEvent).toBe(false)
    }
  })

  it("isAuthorizedEvent rejects Object.create(prototype) fakes that pass instanceof", () => {
    const fake = Object.create(AuthorizedEvent.prototype) as unknown
    expect(fake instanceof AuthorizedEvent).toBe(true)
    expect(isAuthorizedEvent(fake)).toBe(false)
  })
})

// ── AQU-228 BLOCKER 1: __project__ sentinel for comment.* events ──────────────

describe("authorize() — __project__ sentinel (comment.*)", () => {
  async function makeProjectToken(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
    // A project-scoped token still has a fileId claim (that's how sync tokens
    // are minted), but the authorize() sentinel path uses verifyTokenForProject
    // which only checks projectId — so the fileId claim value is irrelevant.
    return makeTestToken(SECRET, { projectId: "proj-a", fileId: "some-file", role: 200, ...partial })
  }

  function makeCommentResolve(
    overrides: Partial<RawEvent<"comment.resolve">> = {},
  ): RawEvent<"comment.resolve"> {
    return {
      id: "cmt-evt-001",
      schemaVersion: 1,
      kind: "comment.resolve",
      projectId: "proj-a",
      fileId: PROJECT_SENTINEL_FILE_ID,
      cellId: undefined,
      parentId: null,
      author: "alice",
      payload: { commentId: "cmt-1", resolved: true },
      clientTs: Date.now(),
      ...overrides,
    }
  }

  function makeCommentCreate(
    overrides: Partial<RawEvent<"comment.create">> = {},
  ): RawEvent<"comment.create"> {
    return {
      id: "cmt-create-001",
      schemaVersion: 1,
      kind: "comment.create",
      projectId: "proj-a",
      fileId: PROJECT_SENTINEL_FILE_ID,
      cellId: undefined,
      parentId: null,
      author: "alice",
      payload: {
        commentId: "cmt-2",
        scope: { kind: "project" },
        body: "Hello",
        parentCommentId: null,
      },
      clientTs: Date.now(),
      ...overrides,
    }
  }

  it("accepts a comment.resolve with __project__ fileId and a project-scoped token", async () => {
    const token = await makeProjectToken({ role: 200 })
    const raw = makeCommentResolve()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.claims.projectId).toBe("proj-a")
      expect(result.event.claims.fileId).toBe(PROJECT_SENTINEL_FILE_ID)
      expect(result.event.claims.roleLevel).toBe(200)
    }
  })

  it("accepts comment.create with __project__ sentinel and COMMENTER token", async () => {
    const token = await makeProjectToken({ role: 200 })
    const raw = makeCommentCreate()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(true)
  })

  it("rejects comment.create with __project__ sentinel when projectId in token mismatches event", async () => {
    // Token for a DIFFERENT project
    const token = await makeProjectToken({ projectId: "proj-b" })
    const raw = makeCommentCreate()
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("rejects a non-comment kind (target.cell.commit) with __project__ fileId — sentinel is comment-only", async () => {
    const token = await makeProjectToken({ role: 400 })
    // A target.cell.commit carrying the sentinel fileId is still rejected with 400
    // (missing fileId for non-comment) — the sentinel is additive only.
    const raw: RawEvent<"target.cell.commit"> = {
      id: "bad-sentinel",
      schemaVersion: 1,
      kind: "target.cell.commit",
      projectId: "proj-a",
      fileId: PROJECT_SENTINEL_FILE_ID, // wrong — only allowed for comment.*
      cellId: "cell-1",
      parentId: null,
      author: "alice",
      payload: { value: "v", valueHtml: "<p>v</p>" },
      clientTs: Date.now(),
    }
    // The sentinel path is entered only for comment kinds. For target.cell.commit
    // the code falls through to verifyTokenForDoc which will check
    // claims.fileId === raw.fileId → "file-x" !== "__project__" → 403.
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    // The token has fileId: "some-file"; raw.fileId is "__project__" → mismatch → 403.
    if (!result.ok) expect(result.status).toBe(403)
  })
})

// ── AQU-228 BLOCKER 2: mixed-batch quarantine regression ──────────────────────
// This test lives in outbox-flush.test.ts (client-side), but the analogous
// server-side invariant is: a token scoped to __project__ MUST NOT be accepted
// for a target.cell.commit event. The tests above cover that. The client-side
// test (groupOldestFileFirst isolation) lives in outbox-flush.test.ts.

// ── AQU-496: assignment.create self-assign carve-out ───────────────────────

describe("authorize() — assignment.create self-assign carve-out (AQU-496)", () => {
  it("PROJECT_LEAD (500) can assign to ANYONE, db omitted (static floor met, carve-out never consulted)", async () => {
    const token = await makeToken({ role: 500, projectId: "proj-a", fileId: "file-x" })
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 999 } })
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(true)
  })

  it("CONTRIBUTOR (400) self-assigning is BLOCKED (403) when db is omitted — carve-out requires a db handle", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x" })
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 1 } })
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("CONTRIBUTOR (400) self-assigning is BLOCKED (403) when allowSelfAssignment is OFF", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x" })
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 1 } })
    const db = makeDb({ allowSelfAssignment: false })
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toContain("assignment.create")
    }
  })

  it("CONTRIBUTOR (400) self-assigning is ALLOWED when allowSelfAssignment is ON", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x" })
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 1 } })
    const db = makeDb({ allowSelfAssignment: true })
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.claims.roleLevel).toBe(400)
    }
  })

  it("CONTRIBUTOR (400) assigning ANOTHER user is BLOCKED (403) even when allowSelfAssignment is ON", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x" })
    // userId 1 (from the token) tries to assign to userId 2 — never allowed
    // below PROJECT_LEAD, regardless of the org setting.
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 2 } })
    const db = makeDb({ allowSelfAssignment: true })
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("VIEWER (100) self-assigning is BLOCKED (403) even when allowSelfAssignment is ON — floor is CONTRIBUTOR (400)+", async () => {
    const token = await makeToken({ role: 100, projectId: "proj-a", fileId: "file-x" })
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 1 } })
    const db = makeDb({ allowSelfAssignment: true })
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("PROJECT_LEAD (500) can assign to ANYONE even when allowSelfAssignment is OFF (leads always can)", async () => {
    const token = await makeToken({ role: 500, projectId: "proj-a", fileId: "file-x" })
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 999 } })
    const db = makeDb({ allowSelfAssignment: false })
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("MAINTAINER (600) can assign to ANYONE regardless of allowSelfAssignment", async () => {
    const token = await makeToken({ role: 600, projectId: "proj-a", fileId: "file-x" })
    const raw = makeAssignmentCreate({ payload: { assignmentId: "asg-1", scopeKind: "books", scope: [{ fileId: "file-x" }], scopeLabel: "Genesis", assigneeUserId: 999 } })
    const db = makeDb({ allowSelfAssignment: false })
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("CONTRIBUTOR self-assigning assignment.reassign is still BLOCKED — carve-out is assignment.create only", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x" })
    const raw: RawEvent<"assignment.reassign"> = {
      id: "reassign-1",
      schemaVersion: 1,
      kind: "assignment.reassign",
      projectId: "proj-a",
      fileId: "file-x",
      cellId: undefined,
      parentId: null,
      author: "alice",
      payload: { assignmentId: "asg-1", assigneeUserId: 1 },
      clientTs: Date.now(),
    }
    const db = makeDb({ allowSelfAssignment: true })
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })
})

describe("authorize() — org-configured assignment floor (AQU-1037)", () => {
  it("allows a contributor to assign another member when the floor is contributor", async () => {
    const token = await makeToken({ role: 400 })
    const raw = makeAssignmentCreate({
      payload: {
        assignmentId: "asg-lowered",
        scopeKind: "books",
        scope: [{ fileId: "file-x" }],
        scopeLabel: "Genesis",
        assigneeUserId: 2,
      },
    })
    const result = await authorize(
      token,
      raw,
      SECRET,
      makeDb({ assignmentMinRole: 400 }),
    )
    expect(result.ok).toBe(true)
  })

  it("applies the same lowered floor to chapter and target-lane assignments", async () => {
    const token = await makeToken({ role: 300 })
    const raw = makeAssignmentCreate({
      payload: {
        assignmentId: "asg-lane",
        scopeKind: "chapters",
        scope: [{ fileId: "file-x", chapter: "GEN 1" }],
        scopeLabel: "Genesis 1",
        assigneeUserId: 2,
        targetLang: "fr",
      },
    })
    const result = await authorize(
      token,
      raw,
      SECRET,
      makeDb({ assignmentMinRole: 300 }),
    )
    expect(result.ok).toBe(true)
  })

  it("applies the configured floor to reassign and unassign", async () => {
    const token = await makeToken({ role: 400 })
    const common = {
      projectId: "proj-a",
      fileId: "file-x",
      cellId: undefined,
      parentId: null,
      author: "alice",
      clientTs: Date.now(),
      schemaVersion: 1 as const,
    }
    const reassign: RawEvent<"assignment.reassign"> = {
      ...common,
      id: "reassign-lowered",
      kind: "assignment.reassign",
      payload: { assignmentId: "asg-1", assigneeUserId: 2 },
    }
    const unassign: RawEvent<"assignment.unassign"> = {
      ...common,
      id: "unassign-lowered",
      kind: "assignment.unassign",
      payload: { assignmentId: "asg-1" },
    }
    const db = makeDb({ assignmentMinRole: 400 })
    expect((await authorize(token, reassign, SECRET, db)).ok).toBe(true)
    expect((await authorize(token, unassign, SECRET, db)).ok).toBe(true)
  })

  it("blocks a project lead when the org raises the floor to maintainer", async () => {
    const token = await makeToken({ role: 500 })
    const raw = makeAssignmentCreate()
    const result = await authorize(
      token,
      raw,
      SECRET,
      makeDb({ assignmentMinRole: 600 }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })
})

// ── AQU-581: assignment.create lane-delegate carve-out ─────────────────────
//
// The mentor/coordinator grant: an org names WHO may hand out chapters in a
// particular target-language lane by (a) giving that member lane scopes and
// (b) turning on allowScopedLaneAssignment — without also making them a
// project lead or org admin. Both halves are required; neither alone grants
// anything. Server-side counterpart of `canSubmitAssignment`'s laneDelegate
// path in src/lib/sync/role-policy.ts.

describe("authorize() — assignment.create lane-delegate carve-out (AQU-581)", () => {
  const LANE_ES = [{ kind: "lane" as const, value: "es" }]

  function laneAssign(
    overrides: { targetLang?: string; assigneeUserId?: number; scope?: { fileId: string }[] } = {},
  ): RawEvent<"assignment.create"> {
    const { targetLang = "es", assigneeUserId = 77, scope = [{ fileId: "file-x" }] } = overrides
    return makeAssignmentCreate({
      payload: {
        assignmentId: "asg-lane",
        scopeKind: "books",
        scope,
        scopeLabel: "Genesis",
        assigneeUserId,
        ...(targetLang === "" ? {} : { targetLang }),
      },
    })
  }

  it("a lane-scoped CONTRIBUTOR (400) may assign ANOTHER user inside a scoped lane when the setting is ON", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event.claims.roleLevel).toBe(400)
  })

  it("the same delegate is BLOCKED (403) in a lane they are NOT scoped to", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(token, laneAssign({ targetLang: "fr" }), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("the same delegate is BLOCKED (403) in the DEFAULT lane ('') — an absent targetLang is not a wildcard", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(token, laneAssign({ targetLang: "" }), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("an UNSCOPED CONTRIBUTOR is BLOCKED (403) even with the setting ON — the setting alone grants nothing", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x" })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("a member scoped ONLY by file (no lane scope) is BLOCKED (403) — the grant is lane-shaped", async () => {
    const token = await makeToken({
      role: 400, projectId: "proj-a", fileId: "file-x",
      scopes: [{ kind: "file", value: "file-x" }],
    })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("a lane-scoped delegate is BLOCKED (403) while the setting is OFF", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: false })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("a lane-scoped delegate is BLOCKED (403) when db is omitted — the carve-out needs a db handle", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const result = await authorize(token, laneAssign(), SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("a lane-scoped REVIEWER (300) is BLOCKED (403) — the delegate floor is CONTRIBUTOR (400)", async () => {
    const token = await makeToken({ role: 300, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("a delegate ALSO scoped by file may assign inside that file", async () => {
    const token = await makeToken({
      role: 400, projectId: "proj-a", fileId: "file-x",
      scopes: [...LANE_ES, { kind: "file", value: "file-x" }],
    })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(token, laneAssign({ scope: [{ fileId: "file-x" }] }), SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("a delegate ALSO scoped by file is BLOCKED (403) when the assignment covers a file outside those scopes", async () => {
    const token = await makeToken({
      role: 400, projectId: "proj-a", fileId: "file-x",
      scopes: [...LANE_ES, { kind: "file", value: "file-x" }],
    })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const result = await authorize(
      token,
      laneAssign({ scope: [{ fileId: "file-x" }, { fileId: "file-other" }] }),
      SECRET,
      db,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("the carve-out is assignment.create ONLY — a delegate's assignment.reassign stays BLOCKED", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true })
    const raw: RawEvent<"assignment.reassign"> = {
      id: "reassign-lane",
      schemaVersion: 1,
      kind: "assignment.reassign",
      projectId: "proj-a",
      fileId: "file-x",
      cellId: undefined,
      parentId: null,
      author: "alice",
      payload: { assignmentId: "asg-lane", assigneeUserId: 77, targetLang: "es" },
      clientTs: Date.now(),
    }
    const result = await authorize(token, raw, SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("PROJECT_LEAD (500) is unaffected — still assigns in any lane with the setting OFF", async () => {
    const token = await makeToken({ role: 500, projectId: "proj-a", fileId: "file-x" })
    const db = makeDb({ allowScopedLaneAssignment: false })
    const result = await authorize(token, laneAssign({ targetLang: "fr" }), SECRET, db)
    expect(result.ok).toBe(true)
  })

  // ── AQU-581 review: the assignee must be able to do the work ──────────────

  it("a delegate is BLOCKED (403) from assigning a VIEWER — they cannot translate", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assigneeRoleLevel: 100 })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      // The dialog shows this reason verbatim, so it must say why.
      expect(result.reason).toBe(
        "this person cannot take work in es: they need to be a Contributor or above and be allowed to work in es",
      )
    }
  })

  it("a delegate is BLOCKED (403) from assigning someone with no role on the project", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assigneeRoleLevel: null })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
  })

  it("a delegate is BLOCKED (403) from assigning Spanish work to a member scoped only to German", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assigneeScopes: [{ kind: "lane", value: "de" }] })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("a delegate may assign a member scoped to the same lane", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assigneeScopes: [{ kind: "lane", value: "es" }] })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("a delegate is BLOCKED (403) from assigning a file outside the assignee's file scopes", async () => {
    const token = await makeToken({ role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assigneeScopes: [{ kind: "file", value: "file-other" }] })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(false)
  })

  it("a lead may still assign a viewer — the assignee check is the delegate's only", async () => {
    const token = await makeToken({ role: 500, projectId: "proj-a", fileId: "file-x" })
    const db = makeDb({ allowScopedLaneAssignment: true, assigneeRoleLevel: 100 })
    const result = await authorize(token, laneAssign(), SECRET, db)
    expect(result.ok).toBe(true)
  })

  // ── AQU-581 review: a delegate can take back what they handed out ──────────

  function laneUnassign(): RawEvent<"assignment.unassign"> {
    return {
      id: "unassign-lane",
      schemaVersion: 1,
      kind: "assignment.unassign",
      projectId: "proj-a",
      fileId: "file-x",
      cellId: undefined,
      parentId: null,
      author: "alice",
      payload: { assignmentId: "asg-lane" },
      clientTs: Date.now(),
    }
  }
  const OWN_ES = { created_by: 42, target_lang: "es", unassigned_at: null }

  it("a delegate may unassign an open assignment they created in a lane they hold", async () => {
    const token = await makeToken({ userId: 42, role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assignmentRow: OWN_ES })
    const result = await authorize(token, laneUnassign(), SECRET, db)
    expect(result.ok).toBe(true)
  })

  it("a delegate is BLOCKED (403) from unassigning someone else's assignment", async () => {
    const token = await makeToken({ userId: 42, role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assignmentRow: { ...OWN_ES, created_by: 7 } })
    const result = await authorize(token, laneUnassign(), SECRET, db)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("a delegate is BLOCKED (403) from unassigning their own assignment in a lane they no longer hold", async () => {
    const token = await makeToken({ userId: 42, role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: true, assignmentRow: { ...OWN_ES, target_lang: "de" } })
    const result = await authorize(token, laneUnassign(), SECRET, db)
    expect(result.ok).toBe(false)
  })

  it("a delegate is BLOCKED (403) from unassigning while the setting is OFF", async () => {
    const token = await makeToken({ userId: 42, role: 400, projectId: "proj-a", fileId: "file-x", scopes: LANE_ES })
    const db = makeDb({ allowScopedLaneAssignment: false, assignmentRow: OWN_ES })
    const result = await authorize(token, laneUnassign(), SECRET, db)
    expect(result.ok).toBe(false)
  })

  it("a file-scoped delegate is BLOCKED (403) when their assignment reaches a file they no longer hold", async () => {
    const token = await makeToken({
      userId: 42, role: 400, projectId: "proj-a", fileId: "file-x",
      scopes: [...LANE_ES, { kind: "file", value: "file-x" }],
    })
    const db = makeDb({ allowScopedLaneAssignment: true, assignmentRow: OWN_ES, assignmentFiles: ["file-x", "file-y"] })
    const result = await authorize(token, laneUnassign(), SECRET, db)
    expect(result.ok).toBe(false)
  })
})

describe("authorize() archived lanes (AQU-1462)", () => {
  const archivedSpanish = {
    lanes: [{ id: "eslane01", name: "Spanish", legacy_tag: "es", archived_at: "2026-09-29T00:00:00.000Z" }],
    projectSettings: { archivedLanes: ["es"], targetLanes: ["es", "fr"] },
  }

  function audioAttach(targetLang?: string): RawEvent<"cell.audio.attach"> {
    return {
      id: "00000000-0000-7000-0000-0000000000aa",
      schemaVersion: 1,
      kind: "cell.audio.attach",
      projectId: "proj-a",
      fileId: "file-x",
      cellId: "cell-1",
      parentId: null,
      author: "alice",
      payload: {
        audioId: "take-1",
        url: "frontier-audio://take-1",
        slot: "recording",
        ...(targetLang ? { targetLang } : {}),
      },
      clientTs: Date.now(),
    }
  }

  it("refuses a target commit that names an archived lane, including from a maintainer", async () => {
    const token = await makeToken({ role: 600 })
    const db = makeDb(archivedSpanish)
    const result = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", targetLang: "es" } }),
      SECRET,
      db,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toBe("lane 'Spanish' is archived")
    }
  })

  it("allows the default lane, an active sibling, and a source edit while Spanish is archived", async () => {
    const token = await makeToken({ role: 400 })
    const db = makeDb({
      lanes: [
        ...archivedSpanish.lanes,
        { id: "frlane01", name: "French", legacy_tag: "fr", archived_at: null },
      ],
      projectSettings: archivedSpanish.projectSettings,
    })
    const defaultLane = await authorize(token, makeTargetCommit(), SECRET, db)
    expect(defaultLane.ok).toBe(true)
    const french = await authorize(
      token,
      makeTargetCommit({ payload: { value: "bonjour", targetLang: "fr" } }),
      SECRET,
      db,
    )
    expect(french.ok).toBe(true)
    const source = await authorize(
      await makeToken({ role: 600 }),
      makeSourceCommit(),
      SECRET,
      db,
    )
    expect(source.ok).toBe(true)
  })

  it("allows a restored lane and refuses a tag that is only listed in settings", async () => {
    const token = await makeToken({ role: 400 })
    const restored = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", targetLang: "es" } }),
      SECRET,
      makeDb({
        lanes: [{ id: "eslane01", name: "Spanish", legacy_tag: "es", archived_at: null }],
        projectSettings: { archivedLanes: [], targetLanes: ["es"] },
      }),
    )
    expect(restored.ok).toBe(true)

    const settingsOnly = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", targetLang: "sw" } }),
      SECRET,
      makeDb({ projectSettings: { archivedLanes: ["sw"] } }),
    )
    expect(settingsOnly.ok).toBe(false)
    if (!settingsOnly.ok) expect(settingsOnly.reason).toBe("lane 'sw' is archived")
  })

  it("refuses lane audio only when the event names the archived lane", async () => {
    const token = await makeToken({ role: 400 })
    const db = makeDb(archivedSpanish)
    const shared = await authorize(token, audioAttach(), SECRET, db)
    expect(shared.ok).toBe(true)
    const named = await authorize(token, audioAttach("es"), SECRET, db)
    expect(named.ok).toBe(false)
    if (!named.ok) expect(named.reason).toBe("lane 'Spanish' is archived")
  })

  it("says the lane does not exist when the caller may not know it (AQU-1462)", async () => {
    const german = {
      lanes: [{ id: "delane01", name: "German", legacy_tag: "de", archived_at: "2026-09-29T00:00:00.000Z" }],
      projectSettings: { archivedLanes: ["de"], targetLanes: ["de"] },
    }
    const hidden = await authorize(
      await makeToken({ role: 400 }),
      makeTargetCommit({ payload: { value: "hallo", targetLang: "German" } }),
      SECRET,
      makeDb(german),
      undefined,
      "1",
    )
    expect(hidden.ok).toBe(false)
    if (!hidden.ok) {
      expect(hidden.status).toBe(403)
      expect(hidden.reason).toBe("lane does not exist")
      expect(hidden.reason).not.toContain("German")
      expect(hidden.reason).not.toContain("archived")
    }

    const belowViewer = await authorize(
      await makeToken({ role: 400, laneGrants: [{ lane: "delane01", level: 99 }] }),
      makeTargetCommit({ payload: { value: "hallo", targetLang: "de" } }),
      SECRET,
      makeDb(german),
      undefined,
      "1",
    )
    expect(belowViewer.ok).toBe(false)
    if (!belowViewer.ok) expect(belowViewer.reason).toBe("lane does not exist")

    const granted = await authorize(
      await makeToken({ role: 400, laneGrants: [{ lane: "delane01", level: 100 }] }),
      makeTargetCommit({ payload: { value: "hallo", targetLang: "de" } }),
      SECRET,
      makeDb(german),
      undefined,
      "1",
    )
    expect(granted.ok).toBe(false)
    if (!granted.ok) expect(granted.reason).toBe("lane 'German' is archived")

    const maintainer = await authorize(
      await makeToken({ role: 600 }),
      makeTargetCommit({ payload: { value: "hallo", targetLang: "German" } }),
      SECRET,
      makeDb(german),
      undefined,
      "1",
    )
    expect(maintainer.ok).toBe(false)
    if (!maintainer.ok) expect(maintainer.reason).toBe("lane 'German' is archived")
  })

  it("reads lane grants for an external token that does not carry them (AQU-1462)", async () => {
    const db = makeDb({
      ...archivedSpanish,
      laneRoleRows: [{ lane: "eslane01", role_level: 400 }],
    })
    const event = makeTargetCommit({ payload: { value: "hola", targetLang: "es" } })
    const granted = await authorize(
      await makeToken({ role: 400, src: "external", userId: 42 }),
      event,
      SECRET,
      db,
      undefined,
      "1",
    )
    expect(granted.ok).toBe(false)
    if (!granted.ok) expect(granted.reason).toBe("lane 'Spanish' is archived")

    const hidden = await authorize(
      await makeToken({ role: 400, src: "external", userId: 42 }),
      event,
      SECRET,
      makeDb(archivedSpanish),
      undefined,
      "1",
    )
    expect(hidden.ok).toBe(false)
    if (!hidden.ok) {
      expect(hidden.reason).toBe("lane does not exist")
      expect(hidden.reason).not.toContain("Spanish")
    }
  })
})
