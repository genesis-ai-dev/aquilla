// Tests for the per-cell audio R2 endpoints. Mirrors the patterns in
// admin.test.ts (stub R2 + direct fetch handler invocation) rather than
// spinning up partyserver/miniflare so we can iterate fast.

import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleAudioRequest, audioObjectKey } from "../audio"
import { handleAdminRequest } from "../admin"
import type { SyncTokenClaims } from "../auth"

const SECRET = "audio-tests-secret"

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  const bucket = {
    async list({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) {
      const keys = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort()
      const start = cursor ? Number(cursor) : 0
      const slice = keys.slice(start, start + 1000)
      const objects = slice.map((k) => ({ key: k, size: store.get(k)!.body.byteLength }))
      const nextStart = start + slice.length
      const truncated = nextStart < keys.length
      return {
        objects,
        truncated,
        cursor: truncated ? String(nextStart) : undefined,
      }
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return {
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
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
    _allKeys() {
      return Array.from(store.keys())
    },
    _size() {
      return store.size
    },
    _seed(key: string, bytes: Uint8Array) {
      store.set(key, {
        key,
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      })
    },
  }
  return bucket
}

type StubEnv = {
  SNAPSHOTS: ReturnType<typeof makeStubBucket>
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

function makeEnv(secret: string | undefined = SECRET): StubEnv {
  return {
    SNAPSHOTS: makeStubBucket(),
    SYNC_SECRET_KEY: secret,
  }
}

async function makeToken(
  partial: Partial<SyncTokenClaims> = {},
  secret: string = SECRET,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: 1,
    projectId: "p1",
    fileId: "f1",
    role: 400,
    aud: "sync",
    iat: now,
    exp: now + 900,
    ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, secret, "HS256")
}

describe("audio R2 endpoints", () => {
  it("returns null for unrelated paths", async () => {
    const env = makeEnv()
    const res = await handleAudioRequest(
      new Request("https://w/admin/anything"),
      // The handler only reads SNAPSHOTS/SYNC_SECRET_KEY/R2_KEY_PREFIX; the
      // bucket cast keeps types narrow while letting the stub stand in.
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )
    expect(res).toBeNull()
  })

  it("answers OPTIONS preflight with permissive CORS", async () => {
    const env = makeEnv()
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", { method: "OPTIONS" }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PUT")
  })

  it("rejects PUT without a valid sync-token", async () => {
    const env = makeEnv()
    const body = new Uint8Array([1, 2, 3, 4])
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "PUT",
        body,
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(401)
  })

  it("PUT then GET round-trips bytes with a valid sync-token", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const body = new Uint8Array([7, 7, 7, 7, 7])
    const put = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "PUT",
        body,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "audio/webm",
        },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(put.status).toBe(200)

    const key = audioObjectKey(env, "p1", "f1", "clip.webm")
    expect(env.SNAPSHOTS._allKeys()).toContain(key)

    const get = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(get.status).toBe(200)
    expect(get.headers.get("Content-Type")).toBe("audio/webm")
    const out = new Uint8Array(await get.arrayBuffer())
    expect(Array.from(out)).toEqual([7, 7, 7, 7, 7])
  })

  it("GET returns 404 for missing audio", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/missing.webm", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(404)
  })

  it("rejects tokens scoped to a different project", async () => {
    const env = makeEnv()
    const token = await makeToken({ projectId: "other", fileId: "f1" })
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "PUT",
        body: new Uint8Array([1]),
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(403)
  })

  it("rejects tokens scoped to a different file", async () => {
    const env = makeEnv()
    const token = await makeToken({ fileId: "other-file" })
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "PUT",
        body: new Uint8Array([1]),
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(403)
  })

  it("DELETE requires SYNC_SECRET_KEY bearer (not the sync-token)", async () => {
    const env = makeEnv()
    const token = await makeToken()
    // sync-token JWT is not enough for DELETE.
    const wrongAuth = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(wrongAuth.status).toBe(401)

    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip.webm"),
      new Uint8Array([9]),
    )
    const ok = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(ok.status).toBe(200)
    expect(env.SNAPSHOTS._size()).toBe(0)
  })

  it("honors R2_KEY_PREFIX when building object keys", async () => {
    const env = makeEnv()
    env.R2_KEY_PREFIX = "pr-7"
    const token = await makeToken()
    await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "PUT",
        body: new Uint8Array([1, 2]),
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )
    expect(env.SNAPSHOTS._allKeys()[0]).toBe(
      "pr-7/projects/p1/files/f1/audio/clip.webm",
    )
  })

  it("admin DELETE on the file wipes the audio subdirectory too", async () => {
    // Smoke-test for the admin DELETE handler — the existing prefix listing
    // already enumerates audio/ alongside snapshot.bin and tail/.
    const env = makeEnv()
    env.SNAPSHOTS._seed("projects/p1/files/f1/snapshot.bin", new Uint8Array([1]))
    env.SNAPSHOTS._seed(
      "projects/p1/files/f1/tail/0000000000000001.bin",
      new Uint8Array([2]),
    )
    env.SNAPSHOTS._seed(
      "projects/p1/files/f1/audio/clip.webm",
      new Uint8Array([3, 3, 3]),
    )
    const res = (await handleAdminRequest(
      new Request("https://w/admin/files/p1/f1", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      env as unknown as Parameters<typeof handleAdminRequest>[1],
    )) as Response
    expect(res.status).toBe(200)
    expect(env.SNAPSHOTS._size()).toBe(0)
  })
})
