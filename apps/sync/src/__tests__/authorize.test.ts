import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { authorize, AuthorizedEvent, isAuthorizedEvent } from "../events/authorize"
import { makeTestToken } from "./helpers/auth"
import type { RawEvent } from "../events/types"
import type { SyncTokenClaims } from "../auth"

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
