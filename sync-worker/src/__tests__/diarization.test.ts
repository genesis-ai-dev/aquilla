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
})
