// AQU-1856 — POST /admin/r2-gc, the on-demand/dry-run face of the sweep.
//
// The route is operator-only and destructive by default, so the gates matter as
// much as the report: an unauthenticated caller must not be able to reach it,
// and a GET must not trigger it.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { handleAdminRequest } from "../admin"
import { DEFAULT_GRACE_MS } from "../r2-gc"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const ADMIN = "admin-secret-value"
const NOW = Date.now()
const OLD = NOW - DEFAULT_GRACE_MS - 7 * 24 * 60 * 60 * 1000

function makeStubBucket(seed: string[] = []) {
  const store = new Map<string, { size: number; uploaded: Date; body: string }>()
  for (const key of seed) store.set(key, { size: 2048, uploaded: new Date(OLD), body: "" })
  return {
    async list({
      prefix = "",
      delimiter,
    }: { prefix?: string; cursor?: string; delimiter?: string } = {}) {
      const matching = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
      if (delimiter) {
        const prefixes = new Set<string>()
        const objects: Array<{ key: string; size: number; uploaded: Date }> = []
        for (const k of matching) {
          const rest = k.slice(prefix.length)
          const i = rest.indexOf(delimiter)
          if (i === -1) objects.push({ key: k, ...store.get(k)! })
          else prefixes.add(prefix + rest.slice(0, i + delimiter.length))
        }
        return { objects, delimitedPrefixes: Array.from(prefixes).sort(), truncated: false, cursor: undefined }
      }
      return {
        objects: matching.map((k) => ({ key: k, ...store.get(k)! })),
        delimitedPrefixes: [] as string[],
        truncated: false,
        cursor: undefined,
      }
    },
    async get(key: string) {
      const obj = store.get(key)
      return obj ? { text: async () => obj.body } : null
    },
    async put(key: string, value: unknown) {
      store.set(key, { size: 1, uploaded: new Date(NOW), body: String(value) })
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
    _has: (k: string) => store.has(k),
  }
}

describe("POST /admin/r2-gc", () => {
  let tdb: TestDb

  beforeEach(async () => {
    if (!tdb) tdb = await makeTestDb()
    else await tdb.reset()
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterAll(async () => {
    await tdb?.close()
  })

  function envFor(bucket: ReturnType<typeof makeStubBucket>) {
    return {
      SNAPSHOTS: bucket as unknown as R2Bucket,
      AQUILLA_PG: tdb.db,
      ADMIN_SECRET: ADMIN,
    }
  }

  const req = (url: string, method = "POST", auth = `Bearer ${ADMIN}`) =>
    new Request(`https://sync.example${url}`, { method, headers: { Authorization: auth } })

  it("rejects a caller without the admin bearer", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const res = await handleAdminRequest(req("/admin/r2-gc", "POST", "Bearer nope"), envFor(bucket))

    expect(res?.status).toBe(401)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("is POST-only — a GET must not be able to trigger a destructive sweep", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const res = await handleAdminRequest(req("/admin/r2-gc", "GET"), envFor(bucket))

    expect(res?.status).toBe(405)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("?dryRun=1 returns a reviewable report and deletes nothing", async () => {
    const bucket = makeStubBucket([
      "projects/p1/files/f1/audio/orphan-a.wav",
      "projects/p1/files/f1/audio/orphan-b.wav",
    ])
    const res = await handleAdminRequest(req("/admin/r2-gc?dryRun=1"), envFor(bucket))
    const body = (await res!.json()) as {
      ok: boolean
      summary: string
      report: { dryRun: boolean; orphaned: number; bytes: number; deleted: number; samples: string[] }
    }

    expect(res?.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.report.dryRun).toBe(true)
    expect(body.report.orphaned).toBe(2)
    expect(body.report.bytes).toBe(4096)
    expect(body.report.deleted).toBe(0)
    expect(body.report.samples).toHaveLength(2)
    expect(body.summary).toContain("dry-run")
    expect(bucket._has("projects/p1/files/f1/audio/orphan-a.wav")).toBe(true)
  })

  it("without dryRun it actually sweeps", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const res = await handleAdminRequest(req("/admin/r2-gc"), envFor(bucket))
    const body = (await res!.json()) as { report: { deleted: number } }

    expect(body.report.deleted).toBe(1)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(false)
  })

  it("?graceHours widens the grace period so recent objects are spared", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    // The object is a week old; a 30-day grace must keep it.
    const res = await handleAdminRequest(req("/admin/r2-gc?graceHours=720"), envFor(bucket))
    const body = (await res!.json()) as { report: { deleted: number; skippedInGrace: number } }

    expect(body.report.deleted).toBe(0)
    expect(body.report.skippedInGrace).toBe(1)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("reports a skipped sweep as 503 rather than a clean empty result", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const res = await handleAdminRequest(
      req("/admin/r2-gc"),
      { ...envFor(bucket), R2_GC_MODE: "off" },
    )

    expect(res?.status).toBe(503)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })
})
