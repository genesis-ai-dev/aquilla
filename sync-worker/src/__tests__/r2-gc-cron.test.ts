// AQU-1856 — the nightly entrypoint around the sweep: the kill switch, the
// cross-environment refusal, and the cursor that makes successive nights walk
// the whole bucket.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { runR2GcSweep, readGcCursors, writeGcCursors, R2_GC_CRON } from "../r2-gc-cron"
import { DEFAULT_GRACE_MS } from "../r2-gc"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const NOW = 1_760_000_000_000
const OLD = NOW - DEFAULT_GRACE_MS - 60_000

/** Stub bucket that keeps put() bodies, so the cursor object round-trips. */
function makeStubBucket(seed: string[] = []) {
  const store = new Map<string, { size: number; uploaded: Date; body: string }>()
  for (const key of seed) store.set(key, { size: 1024, uploaded: new Date(OLD), body: "" })
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
    _body: (k: string) => store.get(k)?.body,
  }
}

type StubBucket = ReturnType<typeof makeStubBucket>

describe("runR2GcSweep", () => {
  let tdb: TestDb

  beforeEach(async () => {
    if (!tdb) tdb = await makeTestDb()
    else await tdb.reset()
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterAll(async () => {
    await tdb?.close()
  })

  function env(bucket: StubBucket, over: Record<string, unknown> = {}) {
    return {
      SNAPSHOTS: bucket as unknown as R2Bucket,
      AQUILLA_PG: tdb.db,
      ...over,
    }
  }

  it("matches the cron expression declared in wrangler.toml", () => {
    expect(R2_GC_CRON).toBe("17 3 * * *")
  })

  it("R2_GC_MODE=off skips the sweep entirely", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const report = await runR2GcSweep(env(bucket, { R2_GC_MODE: "off" }), { now: NOW })

    expect(report).toBeNull()
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("R2_GC_MODE=dry-run reports without deleting", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const report = await runR2GcSweep(env(bucket, { R2_GC_MODE: "dry-run" }), { now: NOW })

    expect(report?.dryRun).toBe(true)
    expect(report?.orphaned).toBe(1)
    expect(report?.deleted).toBe(0)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("refuses to sweep when the profile and the worker name disagree", async () => {
    // A development-profile deploy carrying the production worker name is
    // exactly the mismatch that would GC the wrong environment's media.
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const report = await runR2GcSweep(
      env(bucket, { ENVIRONMENT: "development", DEPLOYMENT_WORKER_NAME: "aquilla-sync-worker" }),
      { now: NOW },
    )

    expect(report).toBeNull()
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("sweeps when the deployed profile and worker name agree", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const report = await runR2GcSweep(
      env(bucket, {
        ENVIRONMENT: "development",
        DEPLOYMENT_WORKER_NAME: "aquilla-sync-worker-dev",
      }),
      { now: NOW },
    )

    expect(report?.deleted).toBe(1)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(false)
  })

  it("persists the cursor it stopped at and resumes from it next run", async () => {
    const bucket = makeStubBucket([
      "projects/p1/files/f1/audio/orphan.wav",
      "projects/p2/files/f1/audio/orphan.wav",
    ])
    const first = await runR2GcSweep(env(bucket), { now: NOW, maxProjects: 1 })
    expect(first?.nextCursors.projects).toBe("projects/p1/")
    expect(await readGcCursors(env(bucket))).toEqual({ projects: "projects/p1/" })
    expect(bucket._has("projects/p2/files/f1/audio/orphan.wav")).toBe(true)

    // No cursor passed in — it must come off the bucket.
    const second = await runR2GcSweep(env(bucket), { now: NOW, maxProjects: 1 })
    expect(second?.deleted).toBe(1)
    expect(bucket._has("projects/p2/files/f1/audio/orphan.wav")).toBe(false)
  })

  it("the cursor object itself is never swept", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    await writeGcCursors(env(bucket), { projects: "projects/p1/" })
    await runR2GcSweep(env(bucket), { now: NOW })
    expect(bucket._has("gc/r2-gc-cursor.json")).toBe(true)
  })

  it("treats a corrupt cursor object as 'start from the top'", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    await bucket.put("gc/r2-gc-cursor.json", "not json{")
    expect(await readGcCursors(env(bucket))).toEqual({})

    const report = await runR2GcSweep(env(bucket), { now: NOW })
    expect(report?.deleted).toBe(1)
  })

  it("skips the sweep rather than guessing when HYPERDRIVE is unbound too", async () => {
    const bucket = makeStubBucket(["projects/p1/files/f1/audio/orphan.wav"])
    const report = await runR2GcSweep(
      { SNAPSHOTS: bucket as unknown as R2Bucket },
      { now: NOW },
    )

    expect(report).toBeNull()
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })
})
