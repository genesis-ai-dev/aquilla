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

function makeRawEvent<K extends "cell.commit" | "thread.add">(
  kind: K,
  overrides: Partial<RawEvent<K>> = {},
): RawEvent<K> {
  const base = {
    id: "00000000-0000-7000-0000-000000000001",
    schemaVersion: 1,
    kind,
    projectId: "proj-a",
    fileId: "file-x",
    author: "alice",
    clientTs: Date.now(),
  }
  if (kind === "cell.commit") {
    return {
      ...base,
      payload: { value: "hello", valueHtml: "<p>hello</p>" },
      ...overrides,
    } as RawEvent<K>
  }
  // thread.add
  return {
    ...base,
    payload: { threadId: "t1", content: "a comment" },
    ...overrides,
  } as RawEvent<K>
}

describe("authorize()", () => {
  it("returns 401 for missing token", async () => {
    const raw = makeRawEvent("cell.commit")
    const result = await authorize(null, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("returns 401 for invalid signature", async () => {
    // Tamper with the signature by signing with a different secret
    const ts = Math.floor(Date.now() / 1000)
    const wrongToken = await sign(
      { userId: 1, projectId: "proj-a", fileId: "file-x", role: 400, aud: "sync", iat: ts, exp: ts + 900 } as Record<string, unknown>,
      "wrong-secret",
      "HS256",
    )
    const raw = makeRawEvent("cell.commit")
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
    const raw = makeRawEvent("cell.commit")
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.reason).toContain("audience")
    }
  })

  it("returns 403 for project mismatch", async () => {
    const token = await makeToken({ projectId: "proj-b" })
    // Event is for proj-a but token is for proj-b
    const raw = makeRawEvent("cell.commit")
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("returns 403 for file mismatch", async () => {
    const token = await makeToken({ fileId: "file-y" })
    // Event is for file-x but token is for file-y
    const raw = makeRawEvent("cell.commit")
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it("returns 403 for low role", async () => {
    // COMMENTER=200 tries to cell.commit which requires CONTRIBUTOR=400
    const token = await makeToken({ role: 200 })
    const raw = makeRawEvent("cell.commit")
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.reason).toContain("cell.commit")
    }
  })

  it("returns 400 for missing fileId on event", async () => {
    const token = await makeToken()
    const raw: RawEvent<"cell.commit"> = {
      ...makeRawEvent("cell.commit"),
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
    const raw = makeRawEvent("cell.commit")
    const result = await authorize(token, raw, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(500)
  })

  it("returns 500 (not 400) when both secret and fileId are missing — spec ordering", async () => {
    // Spec order: secret (→500) checked before fileId (→400).
    // If the order were wrong, the missing fileId would return 400 first.
    const token = await makeToken()
    const raw: RawEvent<"cell.commit"> = {
      ...makeRawEvent("cell.commit"),
      fileId: undefined,
    }
    const result = await authorize(token, raw, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(500)
    }
  })

  it("returns AuthorizedEvent on valid token + sufficient role", async () => {
    const token = await makeToken({ role: 400 })
    const raw = makeRawEvent("cell.commit")
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

  it("uses the token username instead of the client-supplied author", async () => {
    const token = await makeToken({ role: 400, username: "token-alice" })
    const raw = makeRawEvent("cell.commit", { author: "mallory" })
    const result = await authorize(token, raw, SECRET)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.claims.username).toBe("token-alice")
    }
  })

  it("falls back to user:id when an older sync token has no username claim", async () => {
    const token = await makeToken({ role: 400, username: undefined })
    const raw = makeRawEvent("cell.commit", { author: "mallory" })
    const result = await authorize(token, raw, SECRET)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.claims.username).toBe("user:1")
    }
  })

  it("Object.assign produces a non-instanceof plain-object copy", async () => {
    // One of several forgery vectors: Object.assign copies only enumerable
    // string-keyed properties; the Symbol-keyed AUTHORIZED brand is not copied
    // and the prototype chain is lost — so the result is a plain object that
    // fails instanceof. See the Object.create test for a different vector that
    // passes instanceof but still fails isAuthorizedEvent().
    const token = await makeToken({ role: 400 })
    const raw = makeRawEvent("cell.commit")
    const result = await authorize(token, raw, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const real = result.event
      const fake = Object.assign({}, real)
      expect(fake instanceof AuthorizedEvent).toBe(false)
    }
  })

  it("isAuthorizedEvent rejects Object.create(prototype) fakes that pass instanceof", () => {
    // Object.create(AuthorizedEvent.prototype) produces an object whose
    // prototype chain includes AuthorizedEvent.prototype, so it passes
    // `instanceof AuthorizedEvent`. However it was never constructed via
    // authorize(), so the [AUTHORIZED] symbol property was never set.
    // isAuthorizedEvent() checks the symbol brand and must return false.
    const fake = Object.create(AuthorizedEvent.prototype) as unknown
    expect(fake instanceof AuthorizedEvent).toBe(true)
    expect(isAuthorizedEvent(fake)).toBe(false)
  })
})
