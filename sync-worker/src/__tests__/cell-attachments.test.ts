// AQU-777: tests for the per-cell attachment R2 endpoints.
//
// Same shape as audio.test.ts (stub R2 + direct handler invocation rather than
// miniflare). The cases that matter most here are the ones that differ from
// audio: the content-type ALLOW-list, which is the whole reason this route is
// not a flag on the audio one, and the re-check on READ that protects objects
// written before the route existed.

import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import {
  handleCellAttachmentRequest,
  attachmentObjectKey,
  normalizeAttachmentContentType,
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_BYTES,
} from "../cell-attachments"
import type { SyncTokenClaims } from "../auth"

const SECRET = "attachment-tests-secret"

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return {
        size: obj.body.byteLength,
        body: new Response(obj.body).body,
        arrayBuffer: async () => obj.body,
        httpMetadata: obj.httpMetadata,
      }
    },
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array | string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      const body =
        typeof value === "string"
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, { key, body: body as ArrayBuffer, httpMetadata: opts?.httpMetadata })
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
    _allKeys() {
      return Array.from(store.keys())
    },
    _get(key: string) {
      return store.get(key)
    },
    _seed(key: string, bytes: Uint8Array, contentType?: string) {
      store.set(key, {
        key,
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        httpMetadata: contentType ? { contentType } : undefined,
      })
    },
  }
}

type StubEnv = {
  SNAPSHOTS: ReturnType<typeof makeStubBucket>
  SYNC_SECRET_KEY?: string
  ADMIN_SECRET?: string
  R2_KEY_PREFIX?: string
}

function makeEnv(overrides: Partial<StubEnv> = {}): StubEnv {
  return { SNAPSHOTS: makeStubBucket(), SYNC_SECRET_KEY: SECRET, ...overrides }
}

async function makeToken(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: 1,
    projectId: "p1",
    fileId: "f1",
    role: 400, // CONTRIBUTOR
    aud: "sync",
    iat: now,
    exp: now + 900,
    ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const OBJECT = "0198abc1-2345-7def-89ab-0123456789ab.png"

function url(objectName = OBJECT, project = "p1", file = "f1"): string {
  return `https://sync.test/attachments/${project}/${file}/${objectName}`
}

async function put(
  env: StubEnv,
  opts: {
    token: string
    contentType?: string
    body?: BodyInit
    objectName?: string
    project?: string
  } = { token: "" },
): Promise<Response> {
  const res = await handleCellAttachmentRequest(
    new Request(url(opts.objectName, opts.project), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": opts.contentType ?? "image/png",
      },
      body: opts.body ?? PNG,
    }),
    env,
  )
  expect(res).not.toBeNull()
  return res!
}

describe("attachmentObjectKey", () => {
  it("namespaces under the file's attachments prefix", () => {
    expect(attachmentObjectKey({}, "p1", "f1", "a.png")).toBe(
      "projects/p1/files/f1/attachments/a.png",
    )
  })

  it("honours R2_KEY_PREFIX so preview workers stay isolated", () => {
    expect(attachmentObjectKey({ R2_KEY_PREFIX: "pr-42" }, "p1", "f1", "a.png")).toBe(
      "pr-42/projects/p1/files/f1/attachments/a.png",
    )
  })

  it("does not collide with the audio prefix for the same id", () => {
    expect(attachmentObjectKey({}, "p1", "f1", "x.png")).not.toContain("/audio/")
  })
})

describe("normalizeAttachmentContentType", () => {
  it("strips parameters and lowercases", () => {
    expect(normalizeAttachmentContentType("Image/PNG; charset=binary")).toBe("image/png")
  })

  it("maps absent/empty to the empty string, which the allow-list rejects", () => {
    expect(normalizeAttachmentContentType(null)).toBe("")
    expect(ALLOWED_ATTACHMENT_CONTENT_TYPES.has("")).toBe(false)
  })
})

describe("PUT /attachments/:project/:file/:object", () => {
  it("stores the bytes under the file's prefix for a contributor", async () => {
    const env = makeEnv()
    const res = await put(env, { token: await makeToken() })
    expect(res.status).toBe(200)
    expect(env.SNAPSHOTS._allKeys()).toEqual([
      `projects/p1/files/f1/attachments/${OBJECT}`,
    ])
  })

  it("refuses SVG — it is a document that executes script", async () => {
    // The whole reason this route allow-lists rather than deny-listing like
    // audio.ts: the bytes are served back to a browser to be RENDERED, and the
    // GET route accepts the token as `?t=`, so a stored SVG would be a
    // first-party active-content URL needing no victim session.
    const env = makeEnv()
    const res = await put(env, {
      token: await makeToken(),
      contentType: "image/svg+xml",
      objectName: "evil.svg",
    })
    expect(res.status).toBe(415)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("refuses text/html", async () => {
    const env = makeEnv()
    const res = await put(env, {
      token: await makeToken(),
      contentType: "text/html",
      objectName: "evil.html",
    })
    expect(res.status).toBe(415)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("refuses an upload with no declared type", async () => {
    const env = makeEnv()
    const res = await handleCellAttachmentRequest(
      new Request(url(), {
        method: "PUT",
        headers: { Authorization: `Bearer ${await makeToken()}` },
        // fetch supplies no Content-Type for a raw Uint8Array body.
        body: PNG,
      }),
      env,
    )
    expect(res!.status).toBe(415)
  })

  it("rejects a viewer (below the contributor floor)", async () => {
    const env = makeEnv()
    const res = await put(env, { token: await makeToken({ role: 100 }) })
    expect(res.status).toBe(403)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("rejects a token scoped to another project", async () => {
    const env = makeEnv()
    // The token is valid and file-scoped to f1 — but for a DIFFERENT project,
    // so it must not reach p1's key space.
    const res = await put(env, { token: await makeToken({ projectId: "p2" }) })
    expect(res.status).toBe(403)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("rejects an object name that could escape the key template", async () => {
    const env = makeEnv()
    const res = await handleCellAttachmentRequest(
      new Request(`https://sync.test/attachments/p1/f1/${encodeURIComponent("../x.png")}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await makeToken()}`,
          "Content-Type": "image/png",
        },
        body: PNG,
      }),
      env,
    )
    expect(res!.status).toBe(400)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("rejects an empty body", async () => {
    const env = makeEnv()
    const res = await put(env, { token: await makeToken(), body: new Uint8Array(0) })
    expect(res.status).toBe(400)
  })

  it("rejects an oversize upload on the advertised length, before buffering", async () => {
    const env = makeEnv()
    const res = await handleCellAttachmentRequest(
      new Request(url(), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await makeToken()}`,
          "Content-Type": "image/png",
          "Content-Length": String(MAX_ATTACHMENT_BYTES + 1),
        },
        body: PNG,
      }),
      env,
    )
    expect(res!.status).toBe(413)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })
})

describe("GET /attachments/:project/:file/:object", () => {
  it("serves the stored bytes with nosniff to a viewer", async () => {
    const env = makeEnv()
    await put(env, { token: await makeToken() })
    // Viewer role: reads are open to every project member so the whole team
    // sees the reference images.
    const res = await handleCellAttachmentRequest(
      new Request(url(), {
        headers: { Authorization: `Bearer ${await makeToken({ role: 100 })}` },
      }),
      env,
    )
    expect(res!.status).toBe(200)
    expect(res!.headers.get("Content-Type")).toBe("image/png")
    expect(res!.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(PNG)
  })

  it("accepts the token as ?t= so an <img src> can load it", async () => {
    const env = makeEnv()
    await put(env, { token: await makeToken() })
    const token = await makeToken()
    const res = await handleCellAttachmentRequest(
      new Request(`${url()}?t=${encodeURIComponent(token)}`),
      env,
    )
    expect(res!.status).toBe(200)
  })

  it("does NOT accept ?t= on a write", async () => {
    // A URL leaks into logs and history too easily to let one authorize a
    // mutation; writes stay header-only.
    const env = makeEnv()
    const token = await makeToken()
    const res = await handleCellAttachmentRequest(
      new Request(`${url()}?t=${encodeURIComponent(token)}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: PNG,
      }),
      env,
    )
    expect(res!.status).toBe(401)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("downgrades a disallowed stored type on READ, not just on write", async () => {
    // An object written into this prefix before the route existed (or by some
    // other path) must never come back as active content.
    const env = makeEnv()
    env.SNAPSHOTS._seed(
      `projects/p1/files/f1/attachments/${OBJECT}`,
      new TextEncoder().encode("<script>alert(1)</script>"),
      "text/html",
    )
    const res = await handleCellAttachmentRequest(
      new Request(url(), { headers: { Authorization: `Bearer ${await makeToken()}` } }),
      env,
    )
    expect(res!.status).toBe(200)
    expect(res!.headers.get("Content-Type")).toBe("application/octet-stream")
  })

  it("404s a missing object", async () => {
    const env = makeEnv()
    const res = await handleCellAttachmentRequest(
      new Request(url(), { headers: { Authorization: `Bearer ${await makeToken()}` } }),
      env,
    )
    expect(res!.status).toBe(404)
  })
})

describe("DELETE /attachments/:project/:file/:object", () => {
  it("lets a contributor with a matching token clean up an orphan", async () => {
    const env = makeEnv()
    await put(env, { token: await makeToken() })
    const res = await handleCellAttachmentRequest(
      new Request(url(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await makeToken()}` },
      }),
      env,
    )
    expect(res!.status).toBe(200)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("rejects a viewer", async () => {
    const env = makeEnv()
    await put(env, { token: await makeToken() })
    const res = await handleCellAttachmentRequest(
      new Request(url(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await makeToken({ role: 100 })}` },
      }),
      env,
    )
    expect(res!.status).toBe(403)
    expect(env.SNAPSHOTS._allKeys()).toHaveLength(1)
  })

  it("accepts the admin bearer", async () => {
    const env = makeEnv({ ADMIN_SECRET: "admin-secret" })
    await put(env, { token: await makeToken() })
    const res = await handleCellAttachmentRequest(
      new Request(url(), {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-secret" },
      }),
      env,
    )
    expect(res!.status).toBe(200)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })
})

describe("routing", () => {
  it("returns null for a non-attachment path so the dispatcher falls through", async () => {
    expect(
      await handleCellAttachmentRequest(
        new Request("https://sync.test/audio/p1/f1/a.webm"),
        makeEnv(),
      ),
    ).toBeNull()
  })

  it("answers the CORS preflight", async () => {
    const res = await handleCellAttachmentRequest(
      new Request(url(), { method: "OPTIONS" }),
      makeEnv(),
    )
    expect(res!.status).toBe(204)
  })

  it("405s an unsupported method", async () => {
    const res = await handleCellAttachmentRequest(
      new Request(url(), { method: "POST" }),
      makeEnv(),
    )
    expect(res!.status).toBe(405)
  })
})
