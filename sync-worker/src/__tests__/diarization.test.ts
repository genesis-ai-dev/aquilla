// Focused regression test for the authorization floor on POST /diarization/start.
// Starting a job spends real GPU money (Modal), so it must require the same
// CONTRIBUTOR floor as cell.audio.attach — a viewer/commenter/reviewer token
// must be rejected before any Modal call is made.
//
// AQU-1855: plus the guards that keep a job from living forever — the stale-job
// sweep, the live-job cap it feeds, and the streamed audio hand-off to Modal.

import { describe, it, expect, afterEach } from "vitest"
import { sign } from "hono/jwt"
import {
  handleDiarizationRequest,
  reapStaleJobs,
  DIARIZATION_STALE_MS,
  DIARIZATION_TIMEOUT_ERROR,
  DIARIZATION_MAX_LIVE_PER_USER,
  DIARIZATION_MAX_LIVE_PER_PROJECT,
  type DiarizationEnv,
} from "../diarization"
import type { SyncTokenClaims } from "../auth"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "diarization-tests-secret"
const MODAL_URL = "https://acct--diarization-web.modal.run/start"
const MODAL_SECRET = "modal-shared-secret"

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

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubModal() {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
  return () => calls
}

async function makeEnvWithDb(snapshots?: R2Bucket): Promise<{ env: DiarizationEnv; t: TestDb }> {
  const t = await makeTestDb({
    projects: [
      { id: "p1", name: "Test", created_by: 1 },
      { id: "p2", name: "Other", created_by: 1 },
    ],
  })
  return {
    t,
    env: {
      SNAPSHOTS: snapshots ?? ({} as unknown as R2Bucket),
      AQUILLA_PG: t.db,
      SYNC_SECRET_KEY: SECRET,
      DIARIZATION_MODAL_URL: MODAL_URL,
      DIARIZATION_SHARED_SECRET: MODAL_SECRET,
      DIARIZATION_PUBLIC_BASE: "https://sync.example.com",
    },
  }
}

async function makeEnv(): Promise<DiarizationEnv> {
  return (await makeEnvWithDb()).env
}

/** A diarization job row, straight into the table — the state a sweep or a cap
 *  decides on, without driving a start for each one. */
async function insertJob(
  t: TestDb,
  job: {
    id: string
    status: string
    projectId?: string
    fileId?: string
    createdBy?: number | null
    ageMs?: number
    fetchToken?: string
    audioObject?: string
  },
): Promise<void> {
  const updatedAt = Date.now() - (job.ageMs ?? 0)
  await t.pg.query(
    `INSERT INTO diarization_jobs
       (id, project_id, file_id, audio_object, fetch_token, status, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      job.id,
      job.projectId ?? "p1",
      job.fileId ?? "f1",
      job.audioObject ?? "clip.webm",
      job.fetchToken ?? `tok-${job.id}`,
      job.status,
      job.createdBy === undefined ? 1 : job.createdBy,
      updatedAt,
      updatedAt,
    ],
  )
}

async function jobRow(t: TestDb, id: string): Promise<{ status: string; error: string | null }> {
  const r = await t.pg.query<{ status: string; error: string | null }>(
    `SELECT status, error FROM diarization_jobs WHERE id = $1`,
    [id],
  )
  return r.rows[0]!
}

function statusReq(jobId: string, token: string) {
  return new Request(`https://w/api/v1/diarization/status?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

function startReq(token?: string) {
  return new Request("https://w/api/v1/diarization/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ projectId: "p1", fileId: "f1", audioObject: "clip.webm" }),
  })
}

describe("POST /api/v1/diarization/start", () => {
  it("rejects a viewer-role token before calling Modal (billed GPU work)", async () => {
    const env = await makeEnv()
    const getCalls = stubModal()
    const viewerToken = await makeToken({ role: 100 })
    const res = (await handleDiarizationRequest(startReq(viewerToken), env))!
    expect(res.status).toBe(403)
    expect(getCalls()).toBe(0)
  })

  it("allows a contributor-role token to start a job", async () => {
    const env = await makeEnv()
    const getCalls = stubModal()
    const contributorToken = await makeToken({ role: 400 })
    const res = (await handleDiarizationRequest(startReq(contributorToken), env))!
    expect(res.status).toBe(200)
    expect(getCalls()).toBe(1)
  })

  // [Pen test] API security & data exposure (2026-08-27): audioObject is a
  // JSON-body field that lands directly in an R2 key (audioObjectKey) — it
  // must be rejected if it could act as a path separator, matching the
  // isPathSafeId convention already enforced on projectId/fileId elsewhere.
  it("rejects an audioObject that could smuggle a path separator", async () => {
    const env = await makeEnv()
    const getCalls = stubModal()
    const contributorToken = await makeToken({ role: 400 })
    const req = new Request("https://w/api/v1/diarization/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${contributorToken}` },
      body: JSON.stringify({ projectId: "p1", fileId: "f1", audioObject: "../other-project/secret.webm" }),
    })
    const res = (await handleDiarizationRequest(req, env))!
    expect(res.status).toBe(400)
    expect(getCalls()).toBe(0)
  })
})

// ── AQU-1855 ────────────────────────────────────────────────────────────────
// A job is marked `running` the moment Modal accepts it and only ever leaves
// that state when a callback arrives. Modal's container timeout kills the job
// without running its `except` branch, so for the whole class of jobs that die
// that way no callback is ever sent: the row sat at `running` for good and the
// client polled it forever. The sweep below is the one thing that ends them.

describe("the stale-job sweep (AQU-1855)", () => {
  it("fails a job that has been live past the stale window, and the poll says so", async () => {
    const { env, t } = await makeEnvWithDb()
    await insertJob(t, { id: "old-job", status: "running", ageMs: DIARIZATION_STALE_MS + 60_000 })

    const res = (await handleDiarizationRequest(statusReq("old-job", await makeToken()), env))!
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      jobId: "old-job",
      status: "failed",
      error: DIARIZATION_TIMEOUT_ERROR,
    })
    // And durably, not just in the answer — the next poll agrees.
    expect(await jobRow(t, "old-job")).toEqual({ status: "failed", error: DIARIZATION_TIMEOUT_ERROR })
  })

  it("sweeps a job stuck at `queued` too — Modal may die before it ever starts", async () => {
    const { env, t } = await makeEnvWithDb()
    await insertJob(t, { id: "stuck-queued", status: "queued", ageMs: DIARIZATION_STALE_MS + 1 })
    expect(await reapStaleJobs(env)).toBe(1)
    expect((await jobRow(t, "stuck-queued")).status).toBe("failed")
  })

  it("leaves a job that is still inside the window running", async () => {
    const { env, t } = await makeEnvWithDb()
    // A long episode legitimately takes many minutes: still ours to wait for.
    await insertJob(t, { id: "young-job", status: "running", ageMs: DIARIZATION_STALE_MS - 60_000 })

    expect(await reapStaleJobs(env)).toBe(0)
    const res = (await handleDiarizationRequest(statusReq("young-job", await makeToken()), env))!
    expect(await res.json()).toMatchObject({ status: "running" })
    expect(await jobRow(t, "young-job")).toEqual({ status: "running", error: null })
  })

  it("never touches a job that already reported — a slow success is not a timeout", async () => {
    const { env, t } = await makeEnvWithDb()
    await insertJob(t, { id: "done-job", status: "succeeded", ageMs: DIARIZATION_STALE_MS * 10 })
    await insertJob(t, { id: "failed-job", status: "failed", ageMs: DIARIZATION_STALE_MS * 10 })

    expect(await reapStaleJobs(env)).toBe(0)
    expect((await jobRow(t, "done-job")).status).toBe("succeeded")
    expect(await jobRow(t, "failed-job")).toEqual({ status: "failed", error: null })
  })
})

describe("the live-job cap (AQU-1855)", () => {
  it("refuses a start once the user holds the cap, before spending GPU money", async () => {
    const { env, t } = await makeEnvWithDb()
    const getCalls = stubModal()
    for (let i = 0; i < DIARIZATION_MAX_LIVE_PER_USER; i++) {
      // Spread over projects: this is the USER's cap, not a project's.
      await insertJob(t, { id: `mine-${i}`, status: "running", createdBy: 1, projectId: i === 0 ? "p1" : "p2" })
    }

    const res = (await handleDiarizationRequest(startReq(await makeToken({ userId: 1 })), env))!
    expect(res.status).toBe(429)
    expect((await res.json() as { error: string }).error).toMatch(/already have/)
    expect(getCalls()).toBe(0)
    // Nothing was written: a refused start must not leave a row behind.
    const rows = await t.pg.query(`SELECT 1 FROM diarization_jobs WHERE status = 'queued'`)
    expect(rows.rows).toHaveLength(0)
  })

  it("caps a project across users, so one project cannot take the whole GPU pool", async () => {
    const { env, t } = await makeEnvWithDb()
    const getCalls = stubModal()
    for (let i = 0; i < DIARIZATION_MAX_LIVE_PER_PROJECT; i++) {
      await insertJob(t, { id: `theirs-${i}`, status: "running", createdBy: 100 + i, projectId: "p1" })
    }

    const res = (await handleDiarizationRequest(startReq(await makeToken({ userId: 7 })), env))!
    expect(res.status).toBe(429)
    expect((await res.json() as { error: string }).error).toMatch(/this project already has/)
    expect(getCalls()).toBe(0)
  })

  it("releases the slot an abandoned job held: the sweep runs before the count", async () => {
    const { env, t } = await makeEnvWithDb()
    const getCalls = stubModal()
    // At the cap, but every one of them is a job whose callback never arrived.
    for (let i = 0; i < DIARIZATION_MAX_LIVE_PER_USER; i++) {
      await insertJob(t, {
        id: `abandoned-${i}`,
        status: "running",
        createdBy: 1,
        ageMs: DIARIZATION_STALE_MS + 1,
      })
    }

    const res = (await handleDiarizationRequest(startReq(await makeToken({ userId: 1 })), env))!
    expect(res.status).toBe(200)
    expect(getCalls()).toBe(1)
    expect((await jobRow(t, "abandoned-0")).error).toBe(DIARIZATION_TIMEOUT_ERROR)
  })

  it("counts only live jobs — a user's finished history never blocks them", async () => {
    const { env, t } = await makeEnvWithDb()
    const getCalls = stubModal()
    for (let i = 0; i < 20; i++) {
      await insertJob(t, { id: `history-${i}`, status: i % 2 ? "succeeded" : "failed", createdBy: 1 })
    }

    const res = (await handleDiarizationRequest(startReq(await makeToken({ userId: 1 })), env))!
    expect(res.status).toBe(200)
    expect(getCalls()).toBe(1)
  })

  it("records who started the job, so the cap has something to count", async () => {
    const { env, t } = await makeEnvWithDb()
    stubModal()
    const res = (await handleDiarizationRequest(startReq(await makeToken({ userId: 42 })), env))!
    expect(res.status).toBe(200)
    const rows = await t.pg.query<{ created_by: string | number | null }>(
      `SELECT created_by FROM diarization_jobs`,
    )
    expect(rows.rows.map((r) => Number(r.created_by))).toEqual([42])
  })
})

describe("GET /api/v1/diarization/audio — the clip Modal fetches (AQU-1855)", () => {
  /** An R2 object that refuses to be buffered: calling arrayBuffer() is the
   *  bug this guards (a feature-length recording held in a 128 MB isolate). */
  function unbufferableR2(size: number, bytes: Uint8Array) {
    const keys: string[] = []
    const bucket = {
      get: async (key: string) => {
        keys.push(key)
        return {
          size,
          httpMetadata: { contentType: "audio/webm" },
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes)
              c.close()
            },
          }),
          arrayBuffer: () => {
            throw new Error("the audio route must stream the object, not buffer it")
          },
        }
      },
    }
    return { bucket: bucket as unknown as R2Bucket, keys }
  }

  it("streams the R2 body with R2's own size, without reading the object into the isolate", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { bucket, keys } = unbufferableR2(900 * 1024 * 1024, bytes)
    const { env, t } = await makeEnvWithDb(bucket)
    await insertJob(t, { id: "job-a", status: "running", fetchToken: "fetch-token-a" })

    const res = (await handleDiarizationRequest(
      new Request("https://w/api/v1/diarization/audio?jobId=job-a&t=fetch-token-a"),
      env,
    ))!

    expect(res.status).toBe(200)
    // The length Modal is told is R2's metadata, exact without reading a byte.
    expect(res.headers.get("Content-Length")).toBe(String(900 * 1024 * 1024))
    expect(res.headers.get("Content-Type")).toBe("audio/webm")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(keys).toHaveLength(1)
  })

  it("still refuses a wrong fetch token", async () => {
    const { bucket } = unbufferableR2(10, new Uint8Array([0]))
    const { env, t } = await makeEnvWithDb(bucket)
    await insertJob(t, { id: "job-b", status: "running", fetchToken: "fetch-token-b" })
    const res = (await handleDiarizationRequest(
      new Request("https://w/api/v1/diarization/audio?jobId=job-b&t=not-the-token"),
      env,
    ))!
    expect(res.status).toBe(404)
  })
})
