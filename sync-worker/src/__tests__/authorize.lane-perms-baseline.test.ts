// AQU-730 slice 0 — PRE-grant-inversion characterization baseline for the
// sync-worker write wall (authorize.ts → enforceScopes / SCOPE_GATED_KINDS).
//
// These tests pin TODAY'S behavior: an ABSENT `scopes` JWT claim means
// "unscoped = all lanes"; present lane scopes are ADDITIVE restrictions on
// SCOPE_GATED_KINDS only. When grant-based enforcement lands (design §4),
// these expectations INVERT — update this file deliberately; do not delete
// silently.
//
// See: docs/superpowers/specs/2026-09-10-lane-permissions-and-read-wall-design.md §0–§1.

import { describe, it, expect } from "vitest"
import { authorize } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import { PROJECT_SENTINEL_FILE_ID } from "../events/authorize"
import type { RawEvent } from "../events/types"
import type { SyncTokenClaims } from "../auth"

const SECRET = "test-secret"

async function makeToken(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: "proj-a",
    fileId: "file-x",
    role: 400, // contributor — at/above target.cell.commit floor
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

function makeCommentCreate(): RawEvent<"comment.create"> {
  return {
    id: "cmt-create-baseline-001",
    schemaVersion: 1,
    kind: "comment.create",
    projectId: "proj-a",
    fileId: PROJECT_SENTINEL_FILE_ID,
    cellId: undefined,
    parentId: null,
    author: "alice",
    payload: {
      commentId: "cmt-1",
      scope: { kind: "project" },
      body: "baseline note",
      parentCommentId: null,
    },
    clientTs: Date.now(),
  }
}

function makeAudioAttach(): RawEvent<"cell.audio.attach"> {
  return {
    id: "00000000-0000-7000-0000-000000000004",
    schemaVersion: 1,
    kind: "cell.audio.attach",
    projectId: "proj-a",
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload: {
      audioId: "aud-1",
      url: "frontier-audio://clip-1",
      slot: "fr", // lane-ish slot; would be gated if audio were SCOPE_GATED_KINDS
    },
    clientTs: Date.now(),
  }
}

describe("AQU-730 baseline — unscoped token (absent scopes claim)", () => {
  it("authorizes a SCOPE_GATED target.cell.commit on any lane", async () => {
    const token = await makeToken() // no `scopes` key on the JWT
    const res = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang: "es" } }),
      SECRET,
    )
    expect(res.ok).toBe(true)
  })
})

describe("AQU-730 baseline — lane-scoped token", () => {
  const esOnly = [{ kind: "lane" as const, value: "es" }]

  it("authorizes target.cell.commit into the in-scope lane", async () => {
    const token = await makeToken({ scopes: esOnly })
    const res = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang: "es" } }),
      SECRET,
    )
    expect(res.ok).toBe(true)
  })

  it("403s target.cell.commit into an out-of-scope lane", async () => {
    const token = await makeToken({ scopes: esOnly })
    const res = await authorize(
      token,
      makeTargetCommit({ payload: { value: "bonjour", valueHtml: "<p>bonjour</p>", targetLang: "fr" } }),
      SECRET,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(403)
      expect(res.reason).toContain("lane 'fr' not in scope")
    }
  })

  it("403s target.cell.commit into the default lane when only a named lane is scoped", async () => {
    const token = await makeToken({ scopes: esOnly })
    const res = await authorize(token, makeTargetCommit(), SECRET) // omitted targetLang → ''
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(403)
      expect(res.reason).toContain("lane '' not in scope")
    }
  })
})

describe("AQU-730 baseline — default lane is literal ''", () => {
  it("a '' lane scope permits omitted targetLang and rejects a named lane", async () => {
    const token = await makeToken({ scopes: [{ kind: "lane", value: "" }] })

    const defaultLane = await authorize(token, makeTargetCommit(), SECRET)
    expect(defaultLane.ok).toBe(true)

    const namedLane = await authorize(
      token,
      makeTargetCommit({ payload: { value: "hola", valueHtml: "<p>hola</p>", targetLang: "es" } }),
      SECRET,
    )
    expect(namedLane.ok).toBe(false)
    if (!namedLane.ok) {
      expect(namedLane.status).toBe(403)
      expect(namedLane.reason).toContain("lane 'es' not in scope")
    }
  })
})

describe("AQU-730 baseline — non-SCOPE_GATED kinds ignore lane scopes", () => {
  const esOnly = [{ kind: "lane" as const, value: "es" }]

  it("comment.create is not lane-gated even with a narrow lane scope", async () => {
    const token = await makeToken({ role: 200, scopes: esOnly, fileId: PROJECT_SENTINEL_FILE_ID })
    const res = await authorize(token, makeCommentCreate(), SECRET)
    expect(res.ok).toBe(true)
  })

  it("source.cell.commit is not lane-gated even with a narrow lane scope", async () => {
    const token = await makeToken({ role: 700, scopes: esOnly })
    const res = await authorize(token, makeSourceCommit(), SECRET)
    expect(res.ok).toBe(true)
  })

  it("cell.audio.attach is not lane-gated even when payload carries another lane", async () => {
    const token = await makeToken({ scopes: esOnly })
    const res = await authorize(token, makeAudioAttach(), SECRET)
    expect(res.ok).toBe(true)
  })
})
