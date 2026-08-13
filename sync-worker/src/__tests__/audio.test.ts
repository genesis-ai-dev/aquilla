// Tests for the per-cell audio R2 endpoints. Mirrors the patterns in
// admin.test.ts (stub R2 + direct fetch handler invocation) rather than
// spinning up partyserver/miniflare so we can iterate fast.

import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleAudioRequest, audioObjectKey, MAX_AUDIO_BYTES } from "../audio"
import { handleAdminRequest } from "../admin"
import type { SyncTokenClaims } from "../auth"
import { makeTestDb } from "./helpers/pg-test-db"

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
    async get(
      key: string,
      opts?: { range?: { offset?: number; length?: number; suffix?: number } },
    ) {
      const obj = store.get(key)
      if (!obj) return null
      const size = obj.body.byteLength
      let slice = obj.body
      if (opts?.range) {
        const r = opts.range
        if (r.suffix !== undefined) {
          slice = obj.body.slice(Math.max(0, size - r.suffix))
        } else {
          const offset = r.offset ?? 0
          // Mirror R2: an offset at/past the end of the object throws.
          if (offset >= size) throw new Error("range not satisfiable")
          slice = obj.body.slice(
            offset,
            r.length !== undefined ? Math.min(offset + r.length, size) : size,
          )
        }
      }
      return {
        size,
        body: new Response(slice).body,
        arrayBuffer: async () => slice,
        httpMetadata: obj.httpMetadata,
      }
    },
    async head(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { size: obj.body.byteLength }
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

  it("rejects PUT from a viewer-role token (write requires CONTRIBUTOR+)", async () => {
    const env = makeEnv()
    const token = await makeToken({ role: 100 })
    const body = new Uint8Array([1, 2, 3, 4])
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "PUT",
        body,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/webm" },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(403)
    expect(env.SNAPSHOTS._allKeys()).not.toContain(audioObjectKey(env, "p1", "f1", "clip.webm"))
  })

  it("allows GET (read) with a viewer-role token", async () => {
    const env = makeEnv()
    const writer = await makeToken({ role: 400 })
    await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "PUT",
        body: new Uint8Array([9, 9]),
        headers: { Authorization: `Bearer ${writer}`, "Content-Type": "audio/webm" },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )
    const viewer = await makeToken({ role: 100 })
    const get = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        headers: { Authorization: `Bearer ${viewer}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(get.status).toBe(200)
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
    // CACHE-5: audio is immutable per audioId; browsers may cache it for a year.
    expect(get.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    const out = new Uint8Array(await get.arrayBuffer())
    expect(Array.from(out)).toEqual([7, 7, 7, 7, 7])
  })

  it("records imported media as an immutable audio artifact and binding", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "Interview", event_id: "ev1" }],
    })
    const env = { ...makeEnv(), AQUILLA_PG: db }
    const token = await makeToken({ role: 500 })
    const artifactId = "01900000-0000-7000-8000-000000000001"
    const response = await handleAudioRequest(new Request(
      "https://w/audio/p1/f1/clip.wav",
      {
        method: "PUT",
        body: new Uint8Array([7, 8, 9]),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "audio/wav",
          "X-Artifact-Id": artifactId,
          "X-Artifact-Name": "Interview%201.wav",
        },
      },
    ), env as unknown as Parameters<typeof handleAudioRequest>[1])

    expect(response?.status).toBe(200)
    const artifact = await db.prepare(
      `SELECT name, file_id, kind, audio_id, sha256 FROM artifacts WHERE id::text = ?`,
    ).bind(artifactId).first<{
      name: string
      file_id: string
      kind: string
      audio_id: string
      sha256: string
    }>()
    expect(artifact).toMatchObject({
      name: "Interview 1.wav",
      file_id: "f1",
      kind: "audio",
      audio_id: "clip.wav",
    })
    expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const binding = await db.prepare(
      `SELECT binding_role, profile_id, fidelity FROM artifact_bindings WHERE artifact_id::text = ?`,
    ).bind(artifactId).first<{ binding_role: string; profile_id: string; fidelity: string }>()
    expect(binding).toEqual({
      binding_role: "source",
      profile_id: "builtin:media",
      fidelity: "preserved-only",
    })
  })

  it("rejects an imported-media artifact id owned by another project", async () => {
    const artifactId = "01900000-0000-7000-8000-000000000001"
    const { db } = await makeTestDb({
      projects: [
        { id: "p1", name: "First", created_by: 1 },
        { id: "p2", name: "Second", created_by: 1 },
      ],
      files: [
        { id: "f1", project_id: "p1", name: "Interview", event_id: "ev1" },
        { id: "f2", project_id: "p2", name: "Other", event_id: "ev2" },
      ],
    })
    await db.prepare(
      `INSERT INTO artifacts (
         id, project_id, uploaded_by_user_id, credential_id, name, content_type,
         size_bytes, sha256, r2_key, file_id, kind, audio_id, metadata
       ) VALUES (?::uuid, 'p2', '1', NULL, 'other.wav', 'audio/wav', 3, ?, 'other-key', 'f2', 'audio', 'other.wav', '{}'::jsonb)`,
    ).bind(artifactId, "a".repeat(64)).run()
    const env = { ...makeEnv(), AQUILLA_PG: db }
    const response = await handleAudioRequest(new Request("https://w/audio/p1/f1/clip.wav", {
      method: "PUT",
      body: new Uint8Array([7, 8, 9]),
      headers: {
        Authorization: `Bearer ${await makeToken({ role: 500 })}`,
        "Content-Type": "audio/wav",
        "X-Artifact-Id": artifactId,
      },
    }), env as unknown as Parameters<typeof handleAudioRequest>[1])

    expect(response?.status).toBe(409)
    expect(env.SNAPSHOTS._size()).toBe(0)
  })

  // Progressive playback (AQU: time-to-first-audio): media elements can't send
  // Authorization headers, so GET accepts the same sync-token via `?t=`, streams
  // the body, and honours Range so playback starts before the download ends.
  it("GET accepts the sync-token as a ?t= query param", async () => {
    const env = makeEnv()
    const token = await makeToken()
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "clip.webm"), new Uint8Array([1, 2, 3]))
    const res = (await handleAudioRequest(
      new Request(`https://w/audio/p1/f1/clip.webm?t=${encodeURIComponent(token)}`),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(200)
    expect(res.headers.get("Accept-Ranges")).toBe("bytes")
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3])
  })

  it("PUT does NOT accept a ?t= query token (writes stay header-only)", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await handleAudioRequest(
      new Request(`https://w/audio/p1/f1/clip.webm?t=${encodeURIComponent(token)}`, {
        method: "PUT",
        body: new Uint8Array([1]),
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(401)
  })

  // Oversized uploads must fail with a clean 413 (not an opaque 500) — a
  // tester's large mp3 was "basically unusable" because the raw arrayBuffer
  // read blew up with no explanation. Mirrors source-upload-route.ts.
  it("PUT rejects a body over MAX_AUDIO_BYTES with 413", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/huge.mp3", {
        method: "PUT",
        body: new Uint8Array(MAX_AUDIO_BYTES + 1),
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: string; maxBytes: number }
    expect(body.error).toContain("too large")
    expect(body.maxBytes).toBe(MAX_AUDIO_BYTES)
    expect(env.SNAPSHOTS._size()).toBe(0)
  })

  it("PUT rejects early on an oversized Content-Length header", async () => {
    const env = makeEnv()
    const token = await makeToken()
    // Bodyless PUT: the declared length alone must trip the cheap pre-buffer
    // check (the handler must not need to read the body to reject).
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/huge.mp3", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Length": String(MAX_AUDIO_BYTES + 1),
        },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(413)
  })

  it("GET serves a byte range as 206 with Content-Range", async () => {
    const env = makeEnv()
    const token = await makeToken()
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip.webm"),
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    )
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        headers: { Authorization: `Bearer ${token}`, Range: "bytes=2-5" },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(206)
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10")
    expect(res.headers.get("Content-Length")).toBe("4")
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([2, 3, 4, 5])
  })

  it("GET serves open-ended and suffix ranges", async () => {
    const env = makeEnv()
    const token = await makeToken()
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip.webm"),
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    )
    const openEnded = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        headers: { Authorization: `Bearer ${token}`, Range: "bytes=7-" },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get("Content-Range")).toBe("bytes 7-9/10")
    expect(Array.from(new Uint8Array(await openEnded.arrayBuffer()))).toEqual([7, 8, 9])

    const suffix = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        headers: { Authorization: `Bearer ${token}`, Range: "bytes=-3" },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get("Content-Range")).toBe("bytes 7-9/10")
    expect(Array.from(new Uint8Array(await suffix.arrayBuffer()))).toEqual([7, 8, 9])
  })

  it("GET clamps a range that overshoots the object end", async () => {
    const env = makeEnv()
    const token = await makeToken()
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip.webm"),
      new Uint8Array([0, 1, 2, 3, 4]),
    )
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        headers: { Authorization: `Bearer ${token}`, Range: "bytes=3-99" },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(206)
    expect(res.headers.get("Content-Range")).toBe("bytes 3-4/5")
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([3, 4])
  })

  it("GET returns 416 for a range past the end of the object", async () => {
    const env = makeEnv()
    const token = await makeToken()
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip.webm"),
      new Uint8Array([0, 1, 2]),
    )
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        headers: { Authorization: `Bearer ${token}`, Range: "bytes=50-" },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(416)
    expect(res.headers.get("Content-Range")).toBe("bytes */3")
  })

  it("GET ignores malformed and multi-range headers (serves 200 full)", async () => {
    const env = makeEnv()
    const token = await makeToken()
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip.webm"),
      new Uint8Array([0, 1, 2]),
    )
    for (const bad of ["bytes=1-0", "bytes=0-1,2-3", "items=0-1", "bytes=-"]) {
      const res = (await handleAudioRequest(
        new Request("https://w/audio/p1/f1/clip.webm", {
          headers: { Authorization: `Bearer ${token}`, Range: bad },
        }),
        env as unknown as Parameters<typeof handleAudioRequest>[1],
      )) as Response
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Length")).toBe("3")
    }
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

  // F8: DELETE allows either SYNC_SECRET_KEY or a valid sync-token scoped to the file.
  // An invalid/unsigned token is still rejected (401); a SYNC_SECRET_KEY bearer is
  // accepted; a valid sync-token scoped to the correct (project, file) is also accepted.
  it("DELETE allows either SYNC_SECRET_KEY or a valid sync-token scoped to the file (F8)", async () => {
    const env = makeEnv()

    // An invalid/unsigned token is rejected.
    const invalidToken = "not.a.valid.jwt"
    const rejectedInvalid = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${invalidToken}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(rejectedInvalid.status).toBe(401)

    // A valid sync-token scoped to a DIFFERENT file is also rejected.
    const otherFileToken = await makeToken({ fileId: "other-file" })
    const rejectedOtherFile = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${otherFileToken}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(rejectedOtherFile.status).toBe(401)

    // SYNC_SECRET_KEY bearer is accepted (admin path).
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip.webm"),
      new Uint8Array([9]),
    )
    const adminOk = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(adminOk.status).toBe(200)
    expect(env.SNAPSHOTS._size()).toBe(0)

    // A valid sync-token scoped to the correct (project, file) is also accepted (F8).
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "clip2.webm"),
      new Uint8Array([7]),
    )
    const ownerToken = await makeToken({ projectId: "p1", fileId: "f1" })
    const ownerOk = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip2.webm", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(ownerOk.status).toBe(200)
    expect(env.SNAPSHOTS._size()).toBe(0)
  })

  it("rejects DELETE from a viewer-role sync-token (F8 floor is CONTRIBUTOR+)", async () => {
    const env = makeEnv()
    const key = audioObjectKey(env, "p1", "f1", "clip.webm")
    env.SNAPSHOTS._seed(key, new Uint8Array([9]))
    const viewerToken = await makeToken({ role: 100 })
    const res = (await handleAudioRequest(
      new Request("https://w/audio/p1/f1/clip.webm", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(403)
    expect(env.SNAPSHOTS._allKeys()).toContain(key)
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

  // [Pen test] Input validation & injection attacks — the audioId path
  // segment used to flow straight into the R2 key with no charset check.
  // R2 keys aren't filesystem paths (no traversal), but reject anything
  // outside a plain filename charset as defense-in-depth against a decoded
  // `../` or control character ending up embedded in a key.
  it("rejects an audioId containing path-traversal characters", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await handleAudioRequest(
      new Request(
        `https://w/audio/p1/f1/${encodeURIComponent("../../other-project/secret")}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(400)
  })

  it("rejects an audioId containing whitespace or other unexpected characters", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await handleAudioRequest(
      new Request(`https://w/audio/p1/f1/${encodeURIComponent("clip webm")}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as unknown as Parameters<typeof handleAudioRequest>[1],
    )) as Response
    expect(res.status).toBe(400)
  })
})
