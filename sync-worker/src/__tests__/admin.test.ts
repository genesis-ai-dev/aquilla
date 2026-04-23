// Integration-style test for the sync-worker admin endpoint. Uses the SELF
// fetcher partyserver exposes when the worker is invoked via wrangler dev's
// cloudflare:test binding… well, we don't have miniflare bootstrapped here,
// so instead we call the default export's fetch handler directly with a
// hand-rolled Env that stubs SNAPSHOTS. Tight enough to pin the auth +
// routing invariants without the whole DO substrate.

import { describe, it, expect } from "vitest"
import { handleAdminRequest } from "../admin"

interface StoredObject {
  key: string
  body: ArrayBuffer
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  const bucket = {
    async list({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) {
      const keys = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort()
      // Pagination: chunk at 5 for test visibility; real R2 is 1000.
      const start = cursor ? Number(cursor) : 0
      const slice = keys.slice(start, start + 5)
      const objects = slice.map((k) => ({ key: k }))
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
      return { arrayBuffer: async () => obj.body }
    },
    async put(key: string, value: ArrayBuffer | Uint8Array | string) {
      const body =
        typeof value === "string"
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, { key, body: body as ArrayBuffer })
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
    // test helper
    _allKeys() {
      return Array.from(store.keys())
    },
    _size() {
      return store.size
    },
    _seed(key: string, bytes: Uint8Array) {
      store.set(key, { key, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
    },
  }
  return bucket
}

function makeEnv(secret = "shared-secret") {
  const SNAPSHOTS = makeStubBucket()
  const env = {
    SNAPSHOTS,
    SYNC_SECRET_KEY: secret,
  } as any
  return env
}

function seedFile(env: any, projectId: string, fileId: string, tails: number) {
  const prefix = `projects/${projectId}/files/${fileId}`
  env.SNAPSHOTS._seed(`${prefix}/snapshot.bin`, new Uint8Array([1, 2, 3]))
  for (let i = 0; i < tails; i++) {
    env.SNAPSHOTS._seed(
      `${prefix}/tail/${String(i).padStart(16, "0")}.bin`,
      new Uint8Array([i])
    )
  }
  env.SNAPSHOTS._seed(`${prefix}/checkpoints/ckp-1.bin`, new Uint8Array([9, 9]))
}

describe("DELETE /admin/files/:projectId/:fileId", () => {
  it("requires an Authorization header matching SYNC_SECRET_KEY", async () => {
    const env = makeEnv("right")
    seedFile(env, "p", "f", 2)

    const noAuth = await handleAdminRequest(
      new Request("https://worker/admin/files/p/f", { method: "DELETE" }),
      env
    ) as Response
    expect(noAuth.status).toBe(401)
    expect(env.SNAPSHOTS._size()).toBeGreaterThan(0)

    const wrongAuth = await handleAdminRequest(
      new Request("https://worker/admin/files/p/f", {
        method: "DELETE",
        headers: { Authorization: "Bearer wrong" },
      }),
      env
    ) as Response
    expect(wrongAuth.status).toBe(401)
  })

  it("rejects non-DELETE methods", async () => {
    const env = makeEnv("k")
    const res = await handleAdminRequest(
      new Request("https://worker/admin/files/p/f", {
        method: "GET",
        headers: { Authorization: "Bearer k" },
      }),
      env
    ) as Response
    expect(res.status).toBe(405)
  })

  it("returns 404 for malformed admin paths", async () => {
    const env = makeEnv("k")
    const res = await handleAdminRequest(
      new Request("https://worker/admin/unknown", {
        method: "DELETE",
        headers: { Authorization: "Bearer k" },
      }),
      env
    ) as Response
    expect(res.status).toBe(404)
  })

  it("deletes every object under projects/:pid/files/:fid/", async () => {
    const env = makeEnv("k")
    seedFile(env, "proj-1", "file-a", 3)
    // A sibling file whose objects must NOT be deleted
    seedFile(env, "proj-1", "file-b", 2)
    const before = env.SNAPSHOTS._size()

    const res = await handleAdminRequest(
      new Request("https://worker/admin/files/proj-1/file-a", {
        method: "DELETE",
        headers: { Authorization: "Bearer k" },
      }),
      env
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.deleted).toBe(5) // 1 snapshot + 3 tails + 1 checkpoint

    // file-a fully gone, file-b untouched
    expect(env.SNAPSHOTS._allKeys().every((k: string) => !k.includes("file-a"))).toBe(true)
    expect(env.SNAPSHOTS._allKeys().some((k: string) => k.includes("file-b"))).toBe(true)
    expect(env.SNAPSHOTS._size()).toBe(before - 5)
  })

  it("handles paginated list cursors when there are more than one page of tails", async () => {
    const env = makeEnv("k")
    // 12 tails → will span 3 pages of 5 in the stub bucket
    seedFile(env, "proj-1", "file-a", 12)
    const res = await handleAdminRequest(
      new Request("https://worker/admin/files/proj-1/file-a", {
        method: "DELETE",
        headers: { Authorization: "Bearer k" },
      }),
      env
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.deleted).toBe(14) // 1 snap + 12 tails + 1 checkpoint
    expect(env.SNAPSHOTS._size()).toBe(0)
  })

  it("returns 200 with deleted=0 when there's nothing to remove", async () => {
    const env = makeEnv("k")
    const res = await handleAdminRequest(
      new Request("https://worker/admin/files/proj-1/file-a", {
        method: "DELETE",
        headers: { Authorization: "Bearer k" },
      }),
      env
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toEqual({ ok: true, deleted: 0 })
  })

  it("URL-encoded projectId / fileId are decoded before prefix matching", async () => {
    const env = makeEnv("k")
    seedFile(env, "proj 1", "file/a", 1)
    const res = await handleAdminRequest(
      new Request("https://worker/admin/files/proj%201/file%2Fa", {
        method: "DELETE",
        headers: { Authorization: "Bearer k" },
      }),
      env
    ) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.deleted).toBe(3)
  })
})
