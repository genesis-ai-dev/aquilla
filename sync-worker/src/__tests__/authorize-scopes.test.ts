// AQU-553 (Slice 5): lane/file scope enforcement in authorize().
//
// Scopes are ADDITIVE restrictions applied AFTER the role floor passes. The
// matrix below pins:
//   * unscoped token unchanged (regression) — no scopes claim → today's behavior
//   * lane-scoped: allowed-lane commit passes, other-lane commit 403
//   * default-lane '' scope works (empty targetLang matches value '')
//   * source.cell.commit passes regardless of scopes (source rows are shared)
//   * cell.validate gated by lane (payload.targetLang)
//   * file scope composes with lane scope (AND)

import { describe, it, expect } from "vitest"
import { authorize, isAuthorizedEvent } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import type { RawEvent } from "../events/types"
import type { SyncTokenClaims } from "../auth"

const SECRET = "test-secret"

async function makeToken(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: "proj-a",
    fileId: "file-x",
    role: 400,
    ...partial,
  })
}

function makeTargetCommit(
  overrides: Partial<RawEvent<"target.cell.commit">> = {},
): RawEvent<"target.cell.commit"> {
  return {
    id: "00000000-0000-7000-0000-000000000001",
    schemaVersion: 1,
    kind: "target.cell.commit",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: "00000000-0000-7000-0000-000000000000",
    author: "alice",
    payload: { value: "hola", valueHtml: "<p>hola</p>" },
    clientTs: Date.now(),
    ...overrides,
  }
}

function makeSourceCommit(): RawEvent<"source.cell.commit"> {
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
  }
}

function makeValidate(
  overrides: Partial<RawEvent<"cell.validate">> = {},
): RawEvent<"cell.validate"> {
  return {
    id: "00000000-0000-7000-0000-000000000003",
    schemaVersion: 1,
    kind: "cell.validate",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload: { editEventId: "00000000-0000-7000-0000-000000000000" },
    clientTs: Date.now(),
    ...overrides,
  }
}

describe("AQU-553 authorize scopes — regression (unscoped)", () => {
  it("an unscoped token authorizes a target commit exactly as before", async () => {
    const token = await makeToken() // no scopes claim
    const res = await authorize(token, makeTargetCommit({ payload: { value: "x", valueHtml: "<p>x</p>", targetLang: "es" } }), SECRET)
    expect(res.ok).toBe(true)
    if (res.ok) expect(isAuthorizedEvent(res.event)).toBe(true)
  })

  it("an empty scopes array behaves as unscoped", async () => {
    const token = await makeToken({ scopes: [] })
    const res = await authorize(token, makeTargetCommit({ payload: { value: "x", valueHtml: "<p>x</p>", targetLang: "fr" } }), SECRET)
    expect(res.ok).toBe(true)
  })
})

describe("AQU-553 authorize scopes — lane gating", () => {
  it("allows a commit on an in-scope lane", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "es" }] })
    const res = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang: "es" } }),
      SECRET,
    )
    expect(res.ok).toBe(true)
  })

  it("403s a commit on an out-of-scope lane", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "es" }] })
    const res = await authorize(
      token,
      makeTargetCommit({ payload: { value: "bonjour", valueHtml: "<p>bonjour</p>", targetLang: "fr" } }),
      SECRET,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })

  it("403s the default lane when only a non-default lane is in scope", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "es" }] })
    // No targetLang → default lane ''.
    const res = await authorize(token, makeTargetCommit(), SECRET)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })

  it("a '' (default-lane) scope allows a default-lane commit and blocks others", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "" }] })
    const okRes = await authorize(token, makeTargetCommit(), SECRET) // no targetLang
    expect(okRes.ok).toBe(true)

    const blockedRes = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang: "es" } }),
      SECRET,
    )
    expect(blockedRes.ok).toBe(false)
    if (!blockedRes.ok) expect(blockedRes.status).toBe(403)
  })
})

describe("AQU-553 authorize scopes — non-gated kinds", () => {
  it("source.cell.commit passes regardless of lane scopes", async () => {
    // Role 700: source-side writes are importer-gated above contributor; the
    // point here is that scopes don't ALSO gate a source event once the role
    // floor is met.
    const token = await makeToken({ role: 700, scopes: [{ kind: "lane", value: "es" }] })
    const res = await authorize(token, makeSourceCommit(), SECRET)
    expect(res.ok).toBe(true)
  })
})

describe("AQU-553 authorize scopes — validate gating", () => {
  it("allows validate on an in-scope lane", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "es" }] })
    const res = await authorize(
      token,
      makeValidate({ payload: { editEventId: "00000000-0000-7000-0000-000000000000", targetLang: "es" } }),
      SECRET,
    )
    expect(res.ok).toBe(true)
  })

  it("403s validate on an out-of-scope lane", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "es" }] })
    const res = await authorize(
      token,
      makeValidate({ payload: { editEventId: "00000000-0000-7000-0000-000000000000", targetLang: "fr" } }),
      SECRET,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })
})

describe("AQU-553 authorize scopes — lane AND file composition", () => {
  const bothScopes = [
    { kind: "lane" as const, value: "es" },
    { kind: "file" as const, value: "file-x" },
  ]

  it("allows when BOTH lane and file are in scope", async () => {
    const token = await makeToken({ fileId: "file-x", scopes: bothScopes })
    const res = await authorize(
      token,
      makeTargetCommit({ fileId: "file-x", payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang: "es" } }),
      SECRET,
    )
    expect(res.ok).toBe(true)
  })

  it("403s when the lane matches but the file does not", async () => {
    // Token is minted per-file, so fileId claim tracks the event file.
    const token = await makeToken({ fileId: "file-y", scopes: bothScopes })
    const res = await authorize(
      token,
      makeTargetCommit({ fileId: "file-y", payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang: "es" } }),
      SECRET,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })

  it("403s when the file matches but the lane does not", async () => {
    const token = await makeToken({ fileId: "file-x", scopes: bothScopes })
    const res = await authorize(
      token,
      makeTargetCommit({ fileId: "file-x", payload: { value: "bonjour", valueHtml: "<p>bonjour</p>", targetLang: "fr" } }),
      SECRET,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })
})

// ── AQU-1607: a lane scope is a lane id ────────────────────────────────────
//
// Two lanes can be the same language, so a scope holding the language could
// not say which one was meant. A scope holding `lanes.id` can: the event's
// tag is resolved through the project's lane rows and must land on a lane the
// scope names. A value that is no lane's id — a row the AQU-1616 backfill has
// not converted yet, or a lane since removed — is still compared to the tag,
// which is what a scope meant before.

/** Two Spanish lanes: the former default one, and a second with its own tag. */
const SPANISH_LANES = [
  { id: "ln-main", name: "Spanish", legacy_tag: "", archived_at: null },
  { id: "ln-mx", name: "Spanish (Mexico)", legacy_tag: "es-MX", archived_at: null },
]

function makeLanesDb(
  lanes: Array<{ id: string; name: string; legacy_tag: string | null; archived_at: string | null }>,
): AquillaDb {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM projects")) return { org_id: null, created_by: 999, archived_at: null }
              return null
            },
            async all() {
              if (sql.includes("FROM lanes")) {
                return {
                  results: lanes.map((lane) => ({
                    id: lane.id,
                    project_id: "proj-a",
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

function commitInLane(tag: string | undefined): RawEvent<"target.cell.commit"> {
  return makeTargetCommit({
    payload: {
      value: "hola",
      valueHtml: "<p>hola</p>",
      ...(tag === undefined ? {} : { targetLang: tag }),
    },
  })
}

describe("AQU-1607 authorize scopes — lane ids", () => {
  it("admits the lane the id names and refuses its same-language sibling", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "ln-mx" }] })
    const db = makeLanesDb(SPANISH_LANES)

    const allowed = await authorize(token, commitInLane("es-MX"), SECRET, db)
    expect(allowed.ok).toBe(true)

    // Both lanes are Spanish; only one is in scope. Before lane ids the two
    // were the same scope, so this write passed.
    const refused = await authorize(token, commitInLane(undefined), SECRET, db)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.status).toBe(403)
  })

  it("admits the former default lane through its id", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "ln-main" }] })
    const db = makeLanesDb(SPANISH_LANES)

    const allowed = await authorize(token, commitInLane(undefined), SECRET, db)
    expect(allowed.ok).toBe(true)

    const refused = await authorize(token, commitInLane("es-MX"), SECRET, db)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.status).toBe(403)
  })

  it("still enforces a scope row the backfill has not converted yet", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "es-MX" }] })
    const db = makeLanesDb(SPANISH_LANES)

    const allowed = await authorize(token, commitInLane("es-MX"), SECRET, db)
    expect(allowed.ok).toBe(true)

    const refused = await authorize(token, commitInLane(undefined), SECRET, db)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.status).toBe(403)
  })

  it("refuses every lane when the scope names a lane that is gone", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "ln-deleted" }] })
    const db = makeLanesDb(SPANISH_LANES)

    for (const tag of [undefined, "es-MX"]) {
      const res = await authorize(token, commitInLane(tag), SECRET, db)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.status).toBe(403)
    }
  })
})
