// Focused regression test for the authorization floor on POST /diarization/start.
// Starting a job spends real GPU money (Modal), so it must require the same
// CONTRIBUTOR floor as cell.audio.attach — a viewer/commenter/reviewer token
// must be rejected before any Modal call is made.

import { describe, it, expect, afterEach } from "vitest"
import { sign } from "hono/jwt"
import { handleDiarizationRequest, type DiarizationEnv } from "../diarization"
import type { SyncTokenClaims } from "../auth"
import { makeTestDb } from "./helpers/pg-test-db"

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

async function makeEnv(): Promise<DiarizationEnv> {
  const { db } = await makeTestDb({
    projects: [{ id: "p1", name: "Test", created_by: 1 }],
  })
  return {
    SNAPSHOTS: {} as unknown as R2Bucket,
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    DIARIZATION_MODAL_URL: MODAL_URL,
    DIARIZATION_SHARED_SECRET: MODAL_SECRET,
    DIARIZATION_PUBLIC_BASE: "https://sync.example.com",
  }
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

  // ── AQU-1849: the Modal start call is deadline-bounded ────────────────────
  //
  // The kick-off is a handshake — Modal spawns the GPU job and answers at once,
  // the turns arrive later on /callback — so a call still open seconds later is
  // a hang, not a slow job. Unbounded, it held the Worker invocation until the
  // platform killed it and left the row stuck in 'queued' with nothing to
  // alert on. Two halves to the guard, tested separately: the deadline is
  // ATTACHED to the subrequest, and a BLOWN one is reported as a 504 with the
  // job row failed. (`vendorDeadline`/`AbortSignal.timeout` firing on time is
  // covered in shared/vendor-timeouts.test.ts, where timers are fake-able.)

  it("attaches a bounded abort signal to the Modal start subrequest", async () => {
    const env = await makeEnv()
    let seen: RequestInit | undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    const res = (await handleDiarizationRequest(startReq(await makeToken({ role: 400 })), env))!

    expect(res.status).toBe(200)
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
    expect(seen?.signal?.aborted).toBe(false)
  })

  it("answers 504 and fails the job when Modal never responds", async () => {
    const env = await makeEnv()
    // What a blown AbortSignal.timeout rejects the fetch with.
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    }) as unknown as typeof fetch

    const res = (await handleDiarizationRequest(startReq(await makeToken({ role: 400 })), env))!

    // 504, not the 502 a dead upstream gets: the difference is what a user can
    // act on ("the service is slow, retry" vs "the service is down").
    expect(res.status).toBe(504)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain("modalDiarizationStart")

    // The row must not be left in 'queued' — nothing would ever move it.
    const { results } = await env.AQUILLA_PG!
      .prepare("SELECT status, error FROM diarization_jobs WHERE project_id = ?")
      .bind("p1")
      .all<{ status: string; error: string | null }>()
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe("failed")
    expect(results[0]?.error).toContain("timed out")
  })
})
