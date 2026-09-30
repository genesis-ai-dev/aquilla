import { afterEach, describe, expect, it, vi } from "vitest"
import { sign } from "hono/jwt"
import { execFileSync } from "node:child_process"
import { fileURLToPath, URL as NodeURL } from "node:url"
import { handleAlignmentRequest, type AlignmentEnv } from "../alignment"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const dbs: TestDb[] = []
const SECRET = "alignment-test-token-secret"
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(dbs.splice(0).map(db => db.close()))
})

async function setup(role = 400) {
  const db = await makeTestDb({ projects: [{ id: "p1", name: "Test", created_by: 1 }] })
  dbs.push(db)
  const now = Math.floor(Date.now() / 1000)
  const token = await sign({ userId: 1, projectId: "p1", fileId: "f1",
    role, aud: "sync", iat: now, exp: now + 900 }, SECRET, "HS256")
  const env: AlignmentEnv = {
    AQUILLA_PG: db.db, SNAPSHOTS: {} as R2Bucket, SYNC_SECRET_KEY: SECRET,
    ALIGNMENT_MODAL_URL: "https://example.modal.run",
    ALIGNMENT_SHARED_SECRET: "alignment-test-service-secret",
    ALIGNMENT_PUBLIC_BASE: "https://sync.example.com",
  }
  const request = (script = "Hello world.") => new Request(
    "https://worker/api/v1/alignment/start", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: "p1", fileId: "f1",
        audioObject: "clip.webm", script, language: "en" }),
    },
  )
  return { env, request, db, token }
}

describe("alignment jobs", () => {
  it.each(["audio", "status", "callback"])(
    "expires stalled jobs through %s and rejects late completion", async route => {
    const { env, request, db, token } = await setup()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")))
    const start = await handleAlignmentRequest(request(), env)
    const { jobId } = await start!.json() as { jobId: string }
    await db.db.prepare("UPDATE alignment_jobs SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 31 * 60 * 1000, jobId).run()
    const before = (await db.rows("alignment_jobs"))[0]
    const readAudio = vi.fn()
    env.SNAPSHOTS = { get: readAudio } as unknown as R2Bucket
    const audioUrl = `https://worker/api/v1/alignment/audio?jobId=${jobId}`
    expect((await handleAlignmentRequest(new Request(`${audioUrl}&t=wrong`), env))?.status)
      .toBe(404)
    expect((await db.rows("alignment_jobs"))[0].status).toBe("running")
    const result = { method: "ctc-forced-alignment", segments: [{
      text: "Hello world.", start: 1, end: 2, confidence: 0.9,
      matchedWords: 2, totalWords: 2, needsReview: false, status: "matched",
    }] }
    if (route === "status") {
      const response = await handleAlignmentRequest(new Request(
        `https://worker/api/v1/alignment/status?jobId=${jobId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ), env)
      expect(await response!.json()).toMatchObject({ status: "failed" })
    }
    if (route === "callback") {
      const response = await handleAlignmentRequest(new Request(
        "https://worker/api/v1/alignment/callback", {
          method: "POST", headers: { "X-Alignment-Secret": env.ALIGNMENT_SHARED_SECRET! },
          body: JSON.stringify({ jobId, status: "done", result }),
        },
      ), env)
      expect(response?.status).toBe(200)
    }
    expect((await handleAlignmentRequest(new Request(
      `${audioUrl}&t=${before.fetch_token}`,
    ), env))?.status).toBe(404)
    expect(readAudio).not.toHaveBeenCalled()
    const status = await handleAlignmentRequest(new Request(
      `https://worker/api/v1/alignment/status?jobId=${jobId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), env)
    expect(await status!.json()).toMatchObject({ status: "failed", error: "Acoustic alignment timed out." })
    const callback = await handleAlignmentRequest(new Request(
      "https://worker/api/v1/alignment/callback", {
        method: "POST", headers: { "X-Alignment-Secret": env.ALIGNMENT_SHARED_SECRET! },
        body: JSON.stringify({ jobId, status: "done", result }),
      },
    ), env)
    expect(callback?.status).toBe(200)
    const after = (await db.rows("alignment_jobs"))[0]
    expect(after.status).toBe("failed")
    expect(after.fetch_token).toBe("")
    expect(after.result_json).toBeNull()
  })

  it("rejects non-object and oversized job requests without starting Modal", async () => {
    const { env } = await setup()
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const body of ["null", "[]", JSON.stringify("x".repeat(1024 * 1024))]) {
      const response = await handleAlignmentRequest(new Request(
        "https://worker/api/v1/alignment/start", { method: "POST", body },
      ), env)
      expect(response?.status).toBe(400)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("persists the real Python paragraph producer's output", async () => {
    const { env, request, db } = await setup()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")))
    const start = await handleAlignmentRequest(request(), env)
    const { jobId } = await start!.json() as { jobId: string }
    const result = JSON.parse(execFileSync("python3", ["-c", `
import json
from alignment_core import build_alignment_result
print(json.dumps(build_alignment_result("Hello world.", [
  {"word": "Hello", "start": 1, "end": 1.4, "score": 0.9},
  {"word": "world.", "start": 1.5, "end": 2, "score": 0.7},
], 5)))
`], { cwd: fileURLToPath(new NodeURL("../../../infra/modal", import.meta.url)),
      encoding: "utf8" }))
    const callback = await handleAlignmentRequest(new Request(
      "https://worker/api/v1/alignment/callback", {
        method: "POST", headers: { "X-Alignment-Secret": env.ALIGNMENT_SHARED_SECRET! },
        body: JSON.stringify({ jobId, status: "done", result }),
      },
    ), env)
    expect(callback?.status).toBe(200)
    const job = (await db.rows("alignment_jobs"))[0]
    expect(JSON.parse(job.result_json as string)).toEqual(result)
  })

  it("rejects malformed model results without changing the queued job", async () => {
    const { env, request, db } = await setup()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")))
    const response = await handleAlignmentRequest(request(), env)
    const { jobId } = await response!.json() as { jobId: string }
    const valid = { text: "Hello world.", start: 1, end: 2, confidence: 0.9,
      matchedWords: 2, totalWords: 2, needsReview: false, status: "matched" }
    const invalid = [
      { segments: [] },
      { method: "ctc-forced-alignment", segments: [] },
      ...[{ start: 3 }, { start: -1 }, { end: null }, { confidence: 1.2 },
        { confidence: 0.1 }, { matchedWords: 3 }, { totalWords: 1.5 },
        { needsReview: "false" }, { status: "unknown" }, { text: "Changed wording" },
      ].map(patch => ({ method: "ctc-forced-alignment", segments: [{ ...valid, ...patch }] })),
    ]
    for (const result of invalid) {
      const callback = await handleAlignmentRequest(new Request(
        "https://worker/api/v1/alignment/callback", {
          method: "POST", headers: { "X-Alignment-Secret": env.ALIGNMENT_SHARED_SECRET! },
          body: JSON.stringify({ jobId, status: "done", result }),
        },
      ), env)
      expect(callback?.status, JSON.stringify(result)).toBe(400)
      const job = (await db.rows("alignment_jobs"))[0]
      expect(job.status).toBe("running")
      expect(job.result_json).toBeNull()
    }
  })

  it("preserves a callback arriving before Modal start returns", async () => {
    const { env, request, db } = await setup()
    const result = { method: "ctc-forced-alignment", segments: [{
      text: "Hello world.", start: 1, end: 2, confidence: 0.9,
      matchedWords: 2, totalWords: 2, needsReview: false, status: "matched",
    }] }
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body)
      const callback = await handleAlignmentRequest(new Request(
        "https://worker/api/v1/alignment/callback", {
          method: "POST", headers: { "X-Alignment-Secret": env.ALIGNMENT_SHARED_SECRET! },
          body: JSON.stringify({ jobId: payload.jobId, status: "done", result }),
        },
      ), env)
      expect(callback?.status).toBe(200)
      return new Response("{}")
    }))
    const response = await handleAlignmentRequest(request(), env)
    expect(await response!.json()).toMatchObject({ status: "done" })
    const job = (await db.rows("alignment_jobs"))[0]
    expect(job.status).toBe("done")
    expect(job.fetch_token).toBe("")
    expect(JSON.parse(job.result_json as string)).toEqual(result)
  })

  it("rejects viewers before paid GPU work", async () => {
    const { env, request } = await setup(100)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const response = await handleAlignmentRequest(request(), env)
    expect(response?.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("starts a contributor job with original script and scoped URLs", async () => {
    const { env, request, db } = await setup()
    const fetch = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetch)
    const response = await handleAlignmentRequest(request(), env)
    expect(response?.status).toBe(200)
    const result = await response!.json() as { jobId: string }
    const payload = JSON.parse(fetch.mock.calls[0][1].body)
    expect(payload.script).toBe("Hello world.")
    expect(payload.jobId).toBe(result.jobId)
    expect(payload.audioUrl).toContain("/alignment/audio?jobId=")
    expect((await db.rows("alignment_jobs"))[0].status).toBe("running")
  })

  it("rejects empty scripts before Modal", async () => {
    const { env, request } = await setup()
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    expect((await handleAlignmentRequest(request(" "), env))?.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects unauthenticated callbacks", async () => {
    const { env } = await setup()
    const response = await handleAlignmentRequest(new Request(
      "https://worker/api/v1/alignment/callback", {
        method: "POST", headers: { "X-Alignment-Secret": "wrong" },
        body: JSON.stringify({ jobId: "job", status: "done" }),
      },
    ), env)
    expect(response?.status).toBe(401)
  })
})
