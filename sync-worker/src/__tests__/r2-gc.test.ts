// AQU-1856 — the R2 orphan sweep, its nightly entrypoint, and its admin route.
//
// The sweep DELETES user media unattended, so these tests are weighted toward
// what it must never touch: anything referenced, anything inside the grace
// period, anything in a namespace it does not own, and anything at all in a
// project whose reference read failed.
//
// All three surfaces live in ONE file on purpose. Every file that calls
// makeTestDb() spins up its own PGlite (WASM) instance, and this package's
// suite runs 3 workers wide on a slow box where `merge-sibling-large-donor`
// already finishes within ~1% of its own 120s timeout. Three files here were
// enough extra parallel load to tip that test over, so the three describes
// share a single database instead.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest"
import {
  classifyKey,
  formatR2GcReport,
  sweepOrphanedR2Objects,
  DEFAULT_GRACE_MS,
} from "../r2-gc"
import { runR2GcSweep, readGcCursors, writeGcCursors, R2_GC_CRON } from "../r2-gc-cron"
import { handleAdminRequest } from "../admin"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const NOW = 1_760_000_000_000
/** Comfortably older than the 24h grace period. */
const OLD = NOW - DEFAULT_GRACE_MS - 60_000
/** Inside the grace period. */
const FRESH = NOW - 60_000
const ADMIN = "admin-secret-value"

interface StubObject {
  key: string
  size: number
  uploaded: Date
  /** Kept so the cursor object round-trips through get()/put(). */
  body: string
}

function makeStubBucket(seed: Array<{ key: string; size?: number; uploaded?: number }> = []) {
  const store = new Map<string, StubObject>()
  for (const s of seed) {
    store.set(s.key, {
      key: s.key,
      size: s.size ?? 1024,
      uploaded: new Date(s.uploaded ?? OLD),
      body: "",
    })
  }
  return {
    async list({
      prefix = "",
      cursor,
      delimiter,
    }: { prefix?: string; cursor?: string; delimiter?: string } = {}) {
      const matching = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
      if (delimiter) {
        // Mirror R2: keys with the delimiter after `prefix` collapse into
        // delimitedPrefixes and drop out of `objects`.
        const prefixes = new Set<string>()
        const objects: StubObject[] = []
        for (const k of matching) {
          const rest = k.slice(prefix.length)
          const i = rest.indexOf(delimiter)
          if (i === -1) objects.push(store.get(k)!)
          else prefixes.add(prefix + rest.slice(0, i + delimiter.length))
        }
        return {
          objects,
          delimitedPrefixes: Array.from(prefixes).sort(),
          truncated: false,
          cursor: undefined,
        }
      }
      // Paginate at 3 so the cursor loops are exercised; real R2 is 1000.
      const start = cursor ? Number(cursor) : 0
      const slice = matching.slice(start, start + 3)
      const next = start + slice.length
      const truncated = next < matching.length
      return {
        objects: slice.map((k) => store.get(k)!),
        delimitedPrefixes: [] as string[],
        truncated,
        cursor: truncated ? String(next) : undefined,
      }
    },
    async get(key: string) {
      const obj = store.get(key)
      return obj ? { text: async () => obj.body } : null
    },
    async put(key: string, value: unknown) {
      store.set(key, { key, size: 1, uploaded: new Date(NOW), body: String(value) })
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
    _keys: () => Array.from(store.keys()).sort(),
    _has: (k: string) => store.has(k),
    _body: (k: string) => store.get(k)?.body,
  }
}

type StubBucket = ReturnType<typeof makeStubBucket>

function take(over: Record<string, unknown> = {}) {
  return {
    project_id: "p1",
    file_id: "f1",
    cell_id: "GEN 1:1",
    audio_id: "take-live.webm",
    slot: "target",
    url: "/audio/p1/f1/take-live.webm",
    deleted: 0,
    event_id: "e1",
    created_ts: 1000,
    ...over,
  }
}

function artifactRow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    project_id: "p1",
    uploaded_by_user_id: "7",
    name: "original.usfm",
    size_bytes: 10,
    sha256: "abc",
    r2_key: "artifacts/p1/11111111-1111-1111-1111-111111111111",
    ...over,
  }
}

/** Project settings carrying a voice library that pins a reference clip. */
function settingsWithVoiceRef(refId: string | null, projectId = "p1") {
  const voices = refId
    ? [{ id: "v1", name: "Narrator", referenceAudioId: refId }]
    : [{ id: "v1", name: "Narrator" }]
  return {
    project_id: projectId,
    settings: JSON.stringify({ ttsSettings: { voices } }),
  }
}

// One PGlite for the whole file — see the header note.
let tdb: TestDb

beforeAll(async () => {
  tdb = await makeTestDb()
})
beforeEach(async () => {
  await tdb.reset()
})
afterAll(async () => {
  await tdb?.close()
})

async function seed(table: string, rows: ReadonlyArray<object>) {
  const cols = Object.keys(rows[0] as object)
  for (const row of rows) {
    const vals = cols.map((c) => (row as Record<string, unknown>)[c])
    await tdb.pg.query(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
        .map((_, i) => `$${i + 1}`)
        .join(", ")})`,
      vals,
    )
  }
}

function envFor(bucket: StubBucket, over: Record<string, unknown> = {}) {
  return {
    SNAPSHOTS: bucket as unknown as R2Bucket,
    AQUILLA_PG: tdb.db,
    ...over,
  }
}

describe("classifyKey", () => {
  it("recognizes the three swept namespaces", () => {
    expect(classifyKey("projects/p1/files/f1/audio/a.webm")).toEqual({
      namespace: "audio",
      projectId: "p1",
      ref: "f1/a.webm",
    })
    expect(classifyKey("projects/p1/voices/ref.webm")).toEqual({
      namespace: "voice",
      projectId: "p1",
      ref: "ref.webm",
    })
    expect(classifyKey("artifacts/p1/art-1")).toEqual({
      namespace: "artifact",
      projectId: "p1",
      ref: "art-1",
    })
    expect(classifyKey("artifacts/p1/art-1/original.usfm")).toEqual({
      namespace: "artifact",
      projectId: "p1",
      ref: "art-1",
    })
  })

  it("maps the Inworld clone cache onto the clip it was derived from", () => {
    expect(classifyKey("projects/p1/voices/ref.webm.inworld.json")).toEqual({
      namespace: "voice",
      projectId: "p1",
      ref: "ref.webm",
    })
  })

  // The allowlist is the sweep's primary safety property: a namespace it has
  // not been taught about must be invisible to it, not fair game.
  it.each([
    "projects/p1/files/f1/tail/0001",
    "projects/p1/files/f1/checkpoints/snap",
    "projects/p1/files/f1/attachments/att-1.png",
    "projects/p1/files/f1/source/original.usfm",
    "projects/p1/files/f1/audio/nested/deeper.webm",
    "gc/r2-gc-cursor.json",
    "feedback/p1/note.json",
    "",
  ])("does not recognize %s", (key) => {
    expect(classifyKey(key)).toBeNull()
  })
})

describe("sweepOrphanedR2Objects", () => {
  it("deletes a TTS clip that was generated but never attached", async () => {
    // AC1: the tab closed before `cell.audio.attach`, so no cell_audio row
    // ever referenced the bytes.
    await seed("cell_audio", [take()])
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/take-live.webm" },
      { key: "projects/p1/files/f1/audio/tts-orphan.wav", size: 4096 },
    ])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(report.deleted).toBe(1)
    expect(report.orphaned).toBe(1)
    expect(report.bytes).toBe(4096)
    expect(report.byNamespace.audio).toEqual({ orphaned: 1, bytes: 4096 })
    expect(bucket._has("projects/p1/files/f1/audio/take-live.webm")).toBe(true)
    expect(bucket._has("projects/p1/files/f1/audio/tts-orphan.wav")).toBe(false)
  })

  it("keeps attached audio, and collects the take a regeneration replaced", async () => {
    // AC2. `deleted = 1` is the soft-delete the projection writes when a take
    // is regenerated — its bytes are exactly what this sweep is for.
    await seed("cell_audio", [
      take(),
      take({ audio_id: "take-superseded.webm", deleted: 1, event_id: "e2" }),
    ])
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/take-live.webm" },
      { key: "projects/p1/files/f1/audio/take-superseded.webm" },
    ])
    await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(bucket._has("projects/p1/files/f1/audio/take-live.webm")).toBe(true)
    expect(bucket._has("projects/p1/files/f1/audio/take-superseded.webm")).toBe(false)
  })

  it("keeps a voice-clone clip a voice in the project library points at", async () => {
    // AC2, the case that is only visible in the settings blob: the user
    // uploaded a reference clip and assigned it to a voice, but has not voiced
    // a single line yet, so nothing in cell_audio mentions it.
    await seed("project_settings", [settingsWithVoiceRef("ref-in-use.webm")])
    const bucket = makeStubBucket([
      { key: "projects/p1/voices/ref-in-use.webm" },
      { key: "projects/p1/voices/ref-in-use.webm.inworld.json" },
      { key: "projects/p1/voices/ref-abandoned.webm" },
      { key: "projects/p1/voices/ref-abandoned.webm.inworld.json" },
    ])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(bucket._has("projects/p1/voices/ref-in-use.webm")).toBe(true)
    // The clone cache lives or dies with its clip.
    expect(bucket._has("projects/p1/voices/ref-in-use.webm.inworld.json")).toBe(true)
    expect(bucket._has("projects/p1/voices/ref-abandoned.webm")).toBe(false)
    expect(bucket._has("projects/p1/voices/ref-abandoned.webm.inworld.json")).toBe(false)
    expect(report.byNamespace.voice.orphaned).toBe(2)
  })

  it("keeps a clip a surviving take records as its source", async () => {
    // "Revert to source" on a denoised/cloned take follows reference_audio_id.
    await seed("cell_audio", [take({ reference_audio_id: "ref-source.webm" })])
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/take-live.webm" },
      { key: "projects/p1/voices/ref-source.webm" },
    ])
    await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })
    expect(bucket._has("projects/p1/voices/ref-source.webm")).toBe(true)
  })

  it("keeps audio a queued diarization job still has to fetch", async () => {
    await seed("diarization_jobs", [
      {
        id: "job-1",
        project_id: "p1",
        file_id: "f1",
        audio_object: "pending-diarize.webm",
        fetch_token: "t",
        status: "queued",
        created_at: 1,
        updated_at: 1,
      },
    ])
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/pending-diarize.webm" }])
    await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })
    expect(bucket._has("projects/p1/files/f1/audio/pending-diarize.webm")).toBe(true)
  })

  it("keeps audio bytes an audio artifact row owns", async () => {
    // Agent-API audio artifacts store bytes in the per-file audio layout with
    // the artifact id standing in for the file id (schema.sql, 0064).
    await seed("artifacts", [artifactRow({ kind: "audio", audio_id: "clip.wav", r2_key: "unused" })])
    const bucket = makeStubBucket([
      { key: "projects/p1/files/11111111-1111-1111-1111-111111111111/audio/clip.wav" },
    ])
    await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })
    expect(
      bucket._has("projects/p1/files/11111111-1111-1111-1111-111111111111/audio/clip.wav"),
    ).toBe(true)
  })

  it("deletes an uploaded original whose artifacts row never landed", async () => {
    await seed("artifacts", [artifactRow()])
    const bucket = makeStubBucket([
      { key: "artifacts/p1/11111111-1111-1111-1111-111111111111" },
      { key: "artifacts/p1/22222222-2222-2222-2222-222222222222/original.usfm", size: 2048 },
    ])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(bucket._has("artifacts/p1/11111111-1111-1111-1111-111111111111")).toBe(true)
    expect(bucket._has("artifacts/p1/22222222-2222-2222-2222-222222222222/original.usfm")).toBe(
      false,
    )
    expect(report.byNamespace.artifact).toEqual({ orphaned: 1, bytes: 2048 })
  })

  it("keeps an artifact whose key spells its UUID in upper case", async () => {
    // `uuid::text` comes back canonical lowercase. A key written in another
    // spelling must not read as orphaned: a false keep costs storage, a false
    // delete costs the user their uploaded original.
    const id = "33333333-3333-3333-3333-333333333333"
    await seed("artifacts", [artifactRow({ id, r2_key: `artifacts/p1/${id}` })])
    const bucket = makeStubBucket([{ key: `artifacts/p1/${id.toUpperCase()}` }])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(report.orphaned).toBe(0)
    expect(bucket._has(`artifacts/p1/${id.toUpperCase()}`)).toBe(true)
  })

  it("never touches an object inside the grace period", async () => {
    // AC: the attach still in flight. Unreferenced, but too young to judge.
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/just-uploaded.wav", uploaded: FRESH },
    ])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(report.skippedInGrace).toBe(1)
    expect(report.scanned).toBe(0)
    expect(report.orphaned).toBe(0)
    expect(bucket._has("projects/p1/files/f1/audio/just-uploaded.wav")).toBe(true)
  })

  it("leaves every namespace it does not own alone", async () => {
    const untouched = [
      "projects/p1/files/f1/tail/0001",
      "projects/p1/files/f1/checkpoints/snap",
      "projects/p1/files/f1/attachments/att-1.png",
      "projects/p1/files/f1/source/original.usfm",
      "gc/r2-gc-cursor.json",
    ]
    const bucket = makeStubBucket(untouched.map((key) => ({ key })))
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(report.orphaned).toBe(0)
    expect(report.deleted).toBe(0)
    for (const key of untouched) expect(bucket._has(key)).toBe(true)
  })

  it("dry run reports counts and bytes and deletes nothing", async () => {
    // AC3.
    await seed("cell_audio", [take()])
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/take-live.webm" },
      { key: "projects/p1/files/f1/audio/orphan-a.wav", size: 1000 },
      { key: "projects/p1/files/f1/audio/orphan-b.wav", size: 2000 },
    ])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW, dryRun: true })

    expect(report.dryRun).toBe(true)
    expect(report.orphaned).toBe(2)
    expect(report.bytes).toBe(3000)
    expect(report.deleted).toBe(0)
    expect(report.samples).toEqual([
      "projects/p1/files/f1/audio/orphan-a.wav",
      "projects/p1/files/f1/audio/orphan-b.wav",
    ])
    expect(bucket._keys()).toHaveLength(3)
    expect(formatR2GcReport(report)).toContain("dry-run")
  })

  it("deletes nothing for a project whose reference read fails", async () => {
    // The one unrecoverable bug in a sweep like this is reading a FAILED query
    // as "nothing is referenced". Fail closed instead.
    const exploding = {
      prepare() {
        return {
          bind() {
            return this
          },
          all() {
            return Promise.reject(new Error("connection reset"))
          },
        }
      },
    } as unknown as AquillaDb
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/take-live.webm" }])
    const report = await sweepOrphanedR2Objects(
      { SNAPSHOTS: bucket as unknown as R2Bucket, AQUILLA_PG: exploding },
      { now: NOW },
    )

    expect(report.projectsFailed).toBe(1)
    expect(report.orphaned).toBe(0)
    expect(report.deleted).toBe(0)
    expect(report.errors[0]).toContain("connection reset")
    expect(bucket._has("projects/p1/files/f1/audio/take-live.webm")).toBe(true)
  })

  it("refuses to sweep with no database handle", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const report = await sweepOrphanedR2Objects({ SNAPSHOTS: bucket as unknown as R2Bucket })

    expect(report.deleted).toBe(0)
    expect(report.errors[0]).toContain("AQUILLA_PG not bound")
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("honours the R2_KEY_PREFIX used for preview isolation", async () => {
    await seed("cell_audio", [take()])
    const bucket = makeStubBucket([
      { key: "pr-42/projects/p1/files/f1/audio/take-live.webm" },
      { key: "pr-42/projects/p1/files/f1/audio/orphan.wav" },
      // Another prefix's object must be outside this sweep entirely.
      { key: "pr-99/projects/p1/files/f1/audio/orphan.wav" },
    ])
    await sweepOrphanedR2Objects(envFor(bucket, { R2_KEY_PREFIX: "pr-42" }), { now: NOW })

    expect(bucket._has("pr-42/projects/p1/files/f1/audio/take-live.webm")).toBe(true)
    expect(bucket._has("pr-42/projects/p1/files/f1/audio/orphan.wav")).toBe(false)
    expect(bucket._has("pr-99/projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("stops at maxProjects and reports a cursor the next run resumes from", async () => {
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/orphan.wav" },
      { key: "projects/p2/files/f1/audio/orphan.wav" },
      { key: "projects/p3/files/f1/audio/orphan.wav" },
    ])
    const first = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW, maxProjects: 1 })
    expect(first.deleted).toBe(1)
    expect(first.truncated).toBe(true)
    expect(first.nextCursors.projects).toBe("projects/p1/")
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(false)
    expect(bucket._has("projects/p2/files/f1/audio/orphan.wav")).toBe(true)

    const second = await sweepOrphanedR2Objects(envFor(bucket), {
      now: NOW,
      maxProjects: 1,
      cursors: first.nextCursors,
    })
    expect(second.deleted).toBe(1)
    expect(bucket._has("projects/p2/files/f1/audio/orphan.wav")).toBe(false)
    expect(bucket._has("projects/p3/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("clears the cursor once the listing has drained, so the next run restarts", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })
    expect(report.truncated).toBe(false)
    expect(report.nextCursors.projects).toBeUndefined()
  })

  it("isolates projects from each other's reference sets", async () => {
    // p2 has an identically-named take; p1's row must not keep p2's bytes alive.
    await seed("cell_audio", [take()])
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/take-live.webm" },
      { key: "projects/p2/files/f1/audio/take-live.webm" },
    ])
    await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(bucket._has("projects/p1/files/f1/audio/take-live.webm")).toBe(true)
    expect(bucket._has("projects/p2/files/f1/audio/take-live.webm")).toBe(false)
  })

  it("tolerates a settings blob whose voices key is not an array", async () => {
    // A malformed blob must not throw the whole project into fail-closed; the
    // SQL guards jsonb_array_elements with a typeof check.
    await seed("project_settings", [
      { project_id: "p1", settings: JSON.stringify({ ttsSettings: { voices: {} } }) },
    ])
    const bucket = makeStubBucket([{ key: "projects/p1/voices/ref.webm" }])
    const report = await sweepOrphanedR2Objects(envFor(bucket), { now: NOW })

    expect(report.projectsFailed).toBe(0)
    expect(report.orphaned).toBe(1)
  })
})

describe("runR2GcSweep", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("matches the cron expression declared in wrangler.toml", () => {
    expect(R2_GC_CRON).toBe("17 3 * * *")
  })

  it("R2_GC_MODE=off skips the sweep entirely", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const report = await runR2GcSweep(envFor(bucket, { R2_GC_MODE: "off" }), { now: NOW })

    expect(report).toBeNull()
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("R2_GC_MODE=dry-run reports without deleting", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const report = await runR2GcSweep(envFor(bucket, { R2_GC_MODE: "dry-run" }), { now: NOW })

    expect(report?.dryRun).toBe(true)
    expect(report?.orphaned).toBe(1)
    expect(report?.deleted).toBe(0)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("refuses to sweep when the profile and the worker name disagree", async () => {
    // A development-profile deploy carrying the production worker name is
    // exactly the mismatch that would GC the wrong environment's media.
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const report = await runR2GcSweep(
      envFor(bucket, {
        ENVIRONMENT: "development",
        DEPLOYMENT_WORKER_NAME: "aquilla-sync-worker",
      }),
      { now: NOW },
    )

    expect(report).toBeNull()
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("sweeps when the deployed profile and worker name agree", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const report = await runR2GcSweep(
      envFor(bucket, {
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
      { key: "projects/p1/files/f1/audio/orphan.wav" },
      { key: "projects/p2/files/f1/audio/orphan.wav" },
    ])
    const first = await runR2GcSweep(envFor(bucket), { now: NOW, maxProjects: 1 })
    expect(first?.nextCursors.projects).toBe("projects/p1/")
    expect(await readGcCursors(envFor(bucket))).toEqual({ projects: "projects/p1/" })
    expect(bucket._has("projects/p2/files/f1/audio/orphan.wav")).toBe(true)

    // No cursor passed in — it must come off the bucket.
    const second = await runR2GcSweep(envFor(bucket), { now: NOW, maxProjects: 1 })
    expect(second?.deleted).toBe(1)
    expect(bucket._has("projects/p2/files/f1/audio/orphan.wav")).toBe(false)
  })

  it("the cursor object itself is never swept", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    await writeGcCursors(envFor(bucket), { projects: "projects/p1/" })
    await runR2GcSweep(envFor(bucket), { now: NOW })
    expect(bucket._has("gc/r2-gc-cursor.json")).toBe(true)
  })

  it("treats a corrupt cursor object as 'start from the top'", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    await bucket.put("gc/r2-gc-cursor.json", "not json{")
    expect(await readGcCursors(envFor(bucket))).toEqual({})

    const report = await runR2GcSweep(envFor(bucket), { now: NOW })
    expect(report?.deleted).toBe(1)
  })

  it("skips the sweep rather than guessing when HYPERDRIVE is unbound too", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const report = await runR2GcSweep({ SNAPSHOTS: bucket as unknown as R2Bucket }, { now: NOW })

    expect(report).toBeNull()
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })
})

describe("POST /admin/r2-gc", () => {
  // The route is operator-only and destructive by default, so the gates matter
  // as much as the report.
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  const req = (url: string, method = "POST", auth = `Bearer ${ADMIN}`) =>
    new Request(`https://sync.example${url}`, { method, headers: { Authorization: auth } })

  const adminEnv = (bucket: StubBucket, over: Record<string, unknown> = {}) =>
    envFor(bucket, { ADMIN_SECRET: ADMIN, ...over })

  it("rejects a caller without the admin bearer", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const res = await handleAdminRequest(
      req("/admin/r2-gc", "POST", "Bearer nope"),
      adminEnv(bucket),
    )

    expect(res?.status).toBe(401)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("is POST-only — a GET must not be able to trigger a destructive sweep", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const res = await handleAdminRequest(req("/admin/r2-gc", "GET"), adminEnv(bucket))

    expect(res?.status).toBe(405)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("?dryRun=1 returns a reviewable report and deletes nothing", async () => {
    const bucket = makeStubBucket([
      { key: "projects/p1/files/f1/audio/orphan-a.wav", size: 2048 },
      { key: "projects/p1/files/f1/audio/orphan-b.wav", size: 2048 },
    ])
    const res = await handleAdminRequest(req("/admin/r2-gc?dryRun=1"), adminEnv(bucket))
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
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const res = await handleAdminRequest(req("/admin/r2-gc"), adminEnv(bucket))
    const body = (await res!.json()) as { report: { deleted: number } }

    expect(body.report.deleted).toBe(1)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(false)
  })

  it("?graceHours widens the grace period so recent objects are spared", async () => {
    // The admin route has no injectable clock, so this one dates the object
    // against the real one: a week old, which the default 24h grace would
    // collect and a 30-day grace must not.
    const bucket = makeStubBucket([
      {
        key: "projects/p1/files/f1/audio/orphan.wav",
        uploaded: Date.now() - 7 * 24 * 60 * 60 * 1000,
      },
    ])
    const res = await handleAdminRequest(req("/admin/r2-gc?graceHours=720"), adminEnv(bucket))
    const body = (await res!.json()) as { report: { deleted: number; skippedInGrace: number } }

    expect(body.report.deleted).toBe(0)
    expect(body.report.skippedInGrace).toBe(1)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })

  it("reports a skipped sweep as 503 rather than a clean empty result", async () => {
    const bucket = makeStubBucket([{ key: "projects/p1/files/f1/audio/orphan.wav" }])
    const res = await handleAdminRequest(
      req("/admin/r2-gc"),
      adminEnv(bucket, { R2_GC_MODE: "off" }),
    )

    expect(res?.status).toBe(503)
    expect(bucket._has("projects/p1/files/f1/audio/orphan.wav")).toBe(true)
  })
})
