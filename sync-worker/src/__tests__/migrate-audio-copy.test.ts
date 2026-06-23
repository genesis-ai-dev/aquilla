// Tests for the fast R2→R2 audio import endpoint. Mirrors audio.test.ts:
// stub R2 buckets + direct handler invocation (no miniflare) for fast iteration.
//
// WHY this matters: the whole "fast import" hinges on (a) deriving the correct
// GitLab LFS object-storage key from an oid, and (b) copying bytes bucket→bucket
// inside Cloudflare without re-uploading. If gitlabLfsKey drifts, every copy
// becomes an lfs-miss; if the idempotency head-check breaks, re-runs re-copy GBs.

import { describe, it, expect } from "vitest"
import { gitlabLfsKey, handleMigrateAudioCopyRequest } from "../events/migrate-audio-copy-route"

const SECRET = "copy-tests-secret"
const OID = "ab12cd34" + "0".repeat(56) // 64 hex chars

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  return {
    async head(key: string) {
      const obj = store.get(key)
      return obj ? { key, size: obj.body.byteLength } : null
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return {
        body: new Blob([obj.body]).stream(),
        httpMetadata: obj.httpMetadata,
      }
    },
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array | ReadableStream | string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      let body: ArrayBuffer
      if (value instanceof ReadableStream) {
        body = await new Response(value).arrayBuffer()
      } else if (typeof value === "string") {
        body = new TextEncoder().encode(value).buffer as ArrayBuffer
      } else if (value instanceof Uint8Array) {
        body = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
      } else {
        body = value
      }
      store.set(key, { key, body, httpMetadata: opts?.httpMetadata })
    },
    _seed(key: string, text: string, contentType?: string) {
      store.set(key, {
        key,
        body: new TextEncoder().encode(text).buffer as ArrayBuffer,
        httpMetadata: contentType ? { contentType } : undefined,
      })
    },
    _get(key: string) {
      return store.get(key)
    },
    _keys() {
      return Array.from(store.keys())
    },
  }
}

function req(body: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request("https://sync.example/migrate/audio-copy", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("gitlabLfsKey", () => {
  it("derives GitLab's oid-sharded object-storage key (oid[0:2]/oid[2:4]/oid[4:])", () => {
    // WHY oid[4:] and not the full oid: verified against the live LFS bucket
    // (codex-attachments-v1-1) — the third segment is the oid with the first 4
    // hex stripped, NOT the full oid. A real object confirmed this:
    //   oid 6adbf08b815108caa53f9bb8a014dc499f454ee7c15201405d12cf7d6533d8b5
    //   key 6a/db/f08b815108caa53f9bb8a014dc499f454ee7c15201405d12cf7d6533d8b5 (87252 B)
    // Putting the full oid in the third segment makes every copy an lfs-miss.
    expect(gitlabLfsKey(OID)).toBe(`${OID.slice(0, 2)}/${OID.slice(2, 4)}/${OID.slice(4)}`)
    expect(gitlabLfsKey("6adbf08b815108caa53f9bb8a014dc499f454ee7c15201405d12cf7d6533d8b5")).toBe(
      "6a/db/f08b815108caa53f9bb8a014dc499f454ee7c15201405d12cf7d6533d8b5",
    )
  })
})

describe("handleMigrateAudioCopyRequest", () => {
  const base = { projectId: "p1", fileId: "f1", audioId: "a1.webm", oid: OID }

  it("copies bytes from the LFS bucket to the snapshots bucket at the live audio key", async () => {
    const LFS_SRC = makeStubBucket()
    const SNAPSHOTS = makeStubBucket()
    LFS_SRC._seed(gitlabLfsKey(OID), "WEBMBYTES", "audio/webm")

    const res = await handleMigrateAudioCopyRequest(req(base), {
      SNAPSHOTS: SNAPSHOTS as unknown as R2Bucket,
      LFS_SRC: LFS_SRC as unknown as R2Bucket,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res?.status).toBe(200)
    expect(await res?.json()).toMatchObject({ copied: true })
    const dest = SNAPSHOTS._get("projects/p1/files/f1/audio/a1.webm")
    expect(dest).toBeTruthy()
    expect(new TextDecoder().decode(dest!.body)).toBe("WEBMBYTES")
  })

  it("is idempotent — skips when the destination already exists (no re-copy)", async () => {
    const LFS_SRC = makeStubBucket()
    const SNAPSHOTS = makeStubBucket()
    LFS_SRC._seed(gitlabLfsKey(OID), "NEWBYTES")
    SNAPSHOTS._seed("projects/p1/files/f1/audio/a1.webm", "ALREADYTHERE")

    const res = await handleMigrateAudioCopyRequest(req(base), {
      SNAPSHOTS: SNAPSHOTS as unknown as R2Bucket,
      LFS_SRC: LFS_SRC as unknown as R2Bucket,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res?.status).toBe(200)
    expect(await res?.json()).toMatchObject({ copied: false, reason: "exists" })
    // unchanged — not overwritten with the source bytes
    expect(new TextDecoder().decode(SNAPSHOTS._get("projects/p1/files/f1/audio/a1.webm")!.body)).toBe(
      "ALREADYTHERE",
    )
  })

  it("reports lfs-miss (404) when the source object is absent — never silently drops", async () => {
    const LFS_SRC = makeStubBucket()
    const SNAPSHOTS = makeStubBucket()
    const res = await handleMigrateAudioCopyRequest(req(base), {
      SNAPSHOTS: SNAPSHOTS as unknown as R2Bucket,
      LFS_SRC: LFS_SRC as unknown as R2Bucket,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res?.status).toBe(404)
    expect(await res?.json()).toMatchObject({ copied: false, reason: "lfs-miss" })
  })

  it("rejects a wrong secret", async () => {
    const res = await handleMigrateAudioCopyRequest(req(base, "Bearer nope"), {
      SNAPSHOTS: makeStubBucket() as unknown as R2Bucket,
      LFS_SRC: makeStubBucket() as unknown as R2Bucket,
      SYNC_SECRET_KEY: SECRET,
    })
    expect(res?.status).toBe(401)
  })

  it("returns null for non-matching paths (lets the router fall through)", async () => {
    const res = await handleMigrateAudioCopyRequest(
      new Request("https://sync.example/something-else", { method: "POST" }),
      {
        SNAPSHOTS: makeStubBucket() as unknown as R2Bucket,
        LFS_SRC: makeStubBucket() as unknown as R2Bucket,
        SYNC_SECRET_KEY: SECRET,
      },
    )
    expect(res).toBeNull()
  })
})
