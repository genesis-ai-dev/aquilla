import { describe, it, expect } from "vitest"
import {
  handleProjectArchiveRequest,
  readArchiveMarker,
  type ArchiveMarker,
} from "../project-archive"

interface StoredObject {
  key: string
  body: ArrayBuffer
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  const bucket = {
    async list({
      prefix,
      cursor,
      delimiter,
    }: { prefix?: string; cursor?: string; delimiter?: string } = {}) {
      const keys = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort()
      const objects = keys.map((k) => ({ key: k }))
      // Emulate delimiter-based "common prefix" discovery. R2 returns the set
      // of unique prefixes ending at the next delimiter after `prefix`.
      let delimitedPrefixes: string[] | undefined = undefined
      if (delimiter && prefix) {
        const seen = new Set<string>()
        for (const k of keys) {
          const rest = k.slice(prefix.length)
          const idx = rest.indexOf(delimiter)
          if (idx >= 0) seen.add(prefix + rest.slice(0, idx + 1))
        }
        delimitedPrefixes = Array.from(seen)
      }
      return {
        objects,
        truncated: false,
        cursor: undefined,
        delimitedPrefixes,
      }
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return {
        arrayBuffer: async () => obj.body,
        json: async () => JSON.parse(new TextDecoder().decode(obj.body)),
      }
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
    _allKeys() { return Array.from(store.keys()) },
    _seed(key: string, content: string | Uint8Array) {
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : content
      store.set(key, {
        key,
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer,
      })
    },
  }
  return bucket
}

function makeEnv(secret = "shared-secret") {
  const SNAPSHOTS = makeStubBucket()
  const env = {
    SNAPSHOTS,
    SYNC_SECRET_KEY: secret,
    FileSync: {} as any,
  } as any
  return env
}

function seedFile(env: any, projectId: string, fileId: string) {
  const prefix = `projects/${projectId}/files/${fileId}`
  env.SNAPSHOTS._seed(`${prefix}/snapshot.bin`, new Uint8Array([1, 2, 3]))
}

describe("POST /admin/projects/:projectId/archive", () => {
  it("requires a matching Authorization header", async () => {
    const env = makeEnv("k")
    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/p1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" }),
      }),
      env,
      async () => {}
    ) as Response
    expect(res.status).toBe(401)
  })

  it("rejects non-POST methods", async () => {
    const env = makeEnv("k")
    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/p1/archive", {
        method: "GET",
        headers: { Authorization: "Bearer k" },
      }),
      env,
      async () => {}
    ) as Response
    expect(res.status).toBe(405)
  })

  it("returns null for non-matching paths so the caller can fall through", async () => {
    const env = makeEnv("k")
    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/files/p/f", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
      }),
      env,
      async () => {}
    )
    expect(res).toBeNull()
  })

  it("writes the R2 archive marker and broadcasts to each file", async () => {
    const env = makeEnv("k")
    seedFile(env, "proj-1", "file-a")
    seedFile(env, "proj-1", "file-b")
    seedFile(env, "proj-2", "other")
    const broadcasts: Array<{ projectId: string; fileId: string; marker: ArchiveMarker }> = []

    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" }),
      }),
      env,
      async (_env, projectId, fileId, marker) => {
        broadcasts.push({ projectId, fileId, marker })
      }
    ) as Response

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.fileCount).toBe(2)

    // Marker is persisted for cold DOs
    const marker = await readArchiveMarker(env.SNAPSHOTS as any, "proj-1")
    expect(marker?.archivedAt).toBe("2026-04-23T12:00:00Z")
    expect(marker?.deletedBy).toBe("alice")

    // Broadcast fired for each of proj-1's files, and not for proj-2
    const touched = broadcasts.map((b) => b.fileId).sort()
    expect(touched).toEqual(["file-a", "file-b"])
  })

  it("unarchive deletes the R2 marker", async () => {
    const env = makeEnv("k")
    seedFile(env, "proj-1", "file-a")
    // First archive, then unarchive.
    await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "alice" }),
      }),
      env,
      async () => {}
    )
    expect(await readArchiveMarker(env.SNAPSHOTS as any, "proj-1")).not.toBeNull()

    await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: null, deletedBy: null }),
      }),
      env,
      async () => {}
    )
    expect(await readArchiveMarker(env.SNAPSHOTS as any, "proj-1")).toBeNull()
  })

  it("decodes URL-encoded projectId", async () => {
    const env = makeEnv("k")
    seedFile(env, "proj 1", "file-a")
    const broadcasts: string[] = []

    const res = await handleProjectArchiveRequest(
      new Request("https://worker/admin/projects/proj%201/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: JSON.stringify({ archivedAt: "2026-04-23T12:00:00Z", deletedBy: "a" }),
      }),
      env,
      async (_env, projectId, fileId) => {
        broadcasts.push(`${projectId}:${fileId}`)
      }
    ) as Response
    expect(res.status).toBe(200)
    expect(broadcasts).toEqual(["proj 1:file-a"])
  })
})
