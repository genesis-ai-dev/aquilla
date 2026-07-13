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
