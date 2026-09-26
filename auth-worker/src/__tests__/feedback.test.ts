// POST /api/v2/feedback — the in-app feedback surface (AQU-1028).
//
// WHY this suite exists: the point of AQU-1028 is that a stuck user's message
// reaches the team *whatever else is misconfigured*. That promise is not one
// behaviour, it's a set of degradations — no analytics consent, no R2 binding,
// no mail binding — each of which could silently swallow the report if the
// route short-circuits on it. Each test below pins one of those, plus the two
// ways the endpoint could be abused (unauthenticated, or looped).
//
// The screenshot path is the producer→consumer seam AGENTS.md rule 12 asks for:
// the bytes the SPA uploads must land under the key the email hands the team,
// so the assertions read the fake bucket with the key taken from the response
// and the mail body — not with a hand-built expectation.

import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import app from "../index"
import type { Env } from "../types"
import { seedUser, jwtFor } from "./helpers/db"
import { FEEDBACK_MAX_PER_USER } from "../utils/rate-limit"
import { MAX_FEEDBACK_DESCRIPTION_CHARS } from "../routes/feedback"

type SentEmail = {
  from: string
  to: string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
}

function makeEmailMock() {
  const sent: SentEmail[] = []
  const send = vi.fn(async (msg: SentEmail) => {
    sent.push(msg)
    return { messageId: "test-message-id" }
  })
  return { binding: { send } as unknown as Env["EMAIL"], sent }
}

/** Minimal in-memory R2 — the PGlite test env has no real bucket. */
class FakeBucket {
  store = new Map<string, Uint8Array>()
  putFailure: Error | null = null
  async put(key: string, value: Uint8Array): Promise<void> {
    if (this.putFailure) throw this.putFailure
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

interface SubmitOptions {
  description?: string
  route?: string
  projectId?: string
  fileId?: string
  sessionReplayUrl?: string
  screenshot?: { bytes: Uint8Array; type: string; name?: string }
  jwt?: string | null
  overrides?: Partial<Env>
}

async function submit(opts: SubmitOptions = {}): Promise<Response> {
  const form = new FormData()
  if (opts.description !== undefined) form.set("description", opts.description)
  if (opts.route !== undefined) form.set("route", opts.route)
  if (opts.projectId !== undefined) form.set("projectId", opts.projectId)
  if (opts.fileId !== undefined) form.set("fileId", opts.fileId)
  if (opts.sessionReplayUrl !== undefined) form.set("sessionReplayUrl", opts.sessionReplayUrl)
  if (opts.screenshot) {
    form.set(
      "screenshot",
      new File([opts.screenshot.bytes as BlobPart], opts.screenshot.name ?? "shot.png", {
        type: opts.screenshot.type,
      }),
    )
  }
  const headers: Record<string, string> = {}
  if (opts.jwt) headers.Authorization = `Bearer ${opts.jwt}`
  // SNAPSHOTS is explicitly overridden (possibly to undefined) so the
  // no-storage branch can be asked for even though the shared env stubs one.
  return app.request(
    "/api/v2/feedback",
    { method: "POST", headers, body: form },
    { ...env, SNAPSHOTS: undefined, ...opts.overrides },
  )
}

let nextUserId = 500

async function signedInUser(username: string): Promise<string> {
  await seedUser(nextUserId++, username)
  return jwtFor(username)
}

describe("POST /api/v2/feedback", () => {
  it("emails the team inbox with the message, context and Reply-To the reporter", async () => {
    const jwt = await signedInUser("fb-basic")
    const email = makeEmailMock()

    const res = await submit({
      description: "The editor eats my first keystroke.",
      route: "/project/p1/file/f1",
      projectId: "p1",
      fileId: "f1",
      sessionReplayUrl: "https://posthog.example/replay/abc",
      jwt,
      overrides: { EMAIL: email.binding },
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; delivered: boolean; screenshotKey: null }
    expect(body.ok).toBe(true)
    expect(body.delivered).toBe(true)
    expect(body.screenshotKey).toBeNull()

    expect(email.sent).toHaveLength(1)
    const msg = email.sent[0]
    expect(msg.to).toEqual(["joel@frontierrnd.com"])
    expect(msg.replyTo).toBe("fb-basic@example.com")
    expect(msg.subject).toContain("fb-basic")
    expect(msg.text).toContain("The editor eats my first keystroke.")
    expect(msg.text).toContain("/project/p1/file/f1")
    expect(msg.text).toContain("https://posthog.example/replay/abc")
  })

  it("stores an attached screenshot in R2 under the key the email hands the team", async () => {
    const jwt = await signedInUser("fb-shot")
    const email = makeEmailMock()
    const bucket = new FakeBucket()

    const res = await submit({
      description: "Look at this layout.",
      route: "/org",
      screenshot: { bytes: PNG_BYTES, type: "image/png" },
      jwt,
      overrides: { EMAIL: email.binding, SNAPSHOTS: bucket as unknown as R2Bucket },
    })

    expect(res.status).toBe(201)
    const { screenshotKey } = (await res.json()) as { screenshotKey: string }
    expect(screenshotKey).toMatch(/^feedback\/\d+\/[0-9a-f-]{36}\.png$/)

    // The seam: bytes land under exactly the key the team is told to look up.
    expect(bucket.store.get(screenshotKey)).toEqual(PNG_BYTES)
    expect(email.sent[0].text).toContain(screenshotKey)
  })

  it("still delivers the message when object storage is unbound, and says the image was lost", async () => {
    const jwt = await signedInUser("fb-nostore")
    const email = makeEmailMock()

    const res = await submit({
      description: "Storage is down but I still need help.",
      screenshot: { bytes: PNG_BYTES, type: "image/png" },
      jwt,
      overrides: { EMAIL: email.binding },
    })

    expect(res.status).toBe(201)
    expect(((await res.json()) as { screenshotKey: null }).screenshotKey).toBeNull()
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0].text).toContain("Storage is down but I still need help.")
    expect(email.sent[0].text).toMatch(/object storage was unavailable/i)
  })

  it("still delivers the message when the R2 put throws", async () => {
    const jwt = await signedInUser("fb-putfail")
    const email = makeEmailMock()
    const bucket = new FakeBucket()
    bucket.putFailure = new Error("R2 exploded")

    const res = await submit({
      description: "Upload will fail.",
      screenshot: { bytes: PNG_BYTES, type: "image/png" },
      jwt,
      overrides: { EMAIL: email.binding, SNAPSHOTS: bucket as unknown as R2Bucket },
    })

    expect(res.status).toBe(201)
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0].text).toMatch(/object storage was unavailable/i)
  })

  it("accepts the report with delivered:false when the worker has no mail binding", async () => {
    const jwt = await signedInUser("fb-nomail")
    const res = await submit({ description: "Local dev report.", jwt })

    expect(res.status).toBe(201)
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(false)
  })

  it("reports a delivery failure rather than claiming success", async () => {
    const jwt = await signedInUser("fb-mailfail")
    const send = vi.fn(async () => {
      throw new Error("SMTP refused")
    })
    const res = await submit({
      description: "This send will fail.",
      jwt,
      overrides: { EMAIL: { send } as unknown as Env["EMAIL"] },
    })

    expect(res.status).toBe(502)
  })

  it("rejects an unauthenticated submission", async () => {
    const res = await submit({ description: "Anonymous shout." })
    expect(res.status).toBe(401)
  })

  it("rejects an empty description", async () => {
    const jwt = await signedInUser("fb-empty")
    expect((await submit({ description: "   ", jwt })).status).toBe(400)
    expect((await submit({ jwt })).status).toBe(400)
  })

  it("rejects a description over the limit", async () => {
    const jwt = await signedInUser("fb-long")
    const res = await submit({
      description: "x".repeat(MAX_FEEDBACK_DESCRIPTION_CHARS + 1),
      jwt,
    })
    expect(res.status).toBe(400)
  })

  it("rejects a non-image attachment rather than storing it under a guessed extension", async () => {
    const jwt = await signedInUser("fb-badtype")
    const bucket = new FakeBucket()
    const res = await submit({
      description: "Here is a zip.",
      screenshot: { bytes: PNG_BYTES, type: "application/zip", name: "payload.zip" },
      jwt,
      overrides: { SNAPSHOTS: bucket as unknown as R2Bucket },
    })

    expect(res.status).toBe(400)
    expect(bucket.store.size).toBe(0)
  })

  it("throttles a single account once it exceeds the per-user cap", async () => {
    const jwt = await signedInUser("fb-flood")
    for (let i = 0; i < FEEDBACK_MAX_PER_USER; i++) {
      const res = await submit({ description: `report ${i}`, jwt })
      expect(res.status).toBe(201)
    }
    const blocked = await submit({ description: "one too many", jwt })
    expect(blocked.status).toBe(429)
  })
})
