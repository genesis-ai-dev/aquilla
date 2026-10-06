// POST /api/v2/feedback — the in-app feedback surface (AQU-1028).
//
// WHY this suite exists: the point of AQU-1028 is that a stuck user's message
// reaches the team *whatever else is misconfigured*. That promise is not one
// behaviour, it's a set of degradations — no analytics consent, no R2 binding,
// no Discord webhook — each of which could silently swallow the report if the
// route short-circuits on it. Each test below pins one of those, plus the two
// ways the endpoint could be abused (unauthenticated, or looped).
//
// The screenshot path is the producer→consumer seam AGENTS.md rule 12 asks for:
// the bytes the SPA uploads must land under the key the Discord card hands the team,
// so the assertions read the fake bucket with the key taken from the response
// and the card footer — not with a hand-built expectation.

import { env } from "cloudflare:test"
import { afterEach, describe, it, expect, vi } from "vitest"
import app from "../index"
import type { Env } from "../types"
import { seedUser, jwtFor } from "./helpers/db"
import { FEEDBACK_MAX_PER_USER } from "../utils/rate-limit"
import { MAX_FEEDBACK_DESCRIPTION_CHARS } from "../routes/feedback"

const WEBHOOK = "https://discord.example/api/webhooks/1/secret-token"

interface Posted {
  url: string
  payload: {
    embeds: {
      title: string
      description: string
      fields: { name: string; value: string }[]
      footer?: { text: string }
      image?: { url: string }
    }[]
    allowed_mentions: { parse: string[] }
  }
  files: Record<string, File>
}

/** Stand-in for Discord: records every webhook POST and answers `status`. */
function mockDiscord(status = 204) {
  const posted: Posted[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const form = init.body as FormData
    const files: Record<string, File> = {}
    for (const [k, v] of form.entries()) if (v instanceof File) files[k] = v
    posted.push({
      url,
      payload: JSON.parse(form.get("payload_json") as string),
      files,
    })
    return new Response(null, { status })
  })
  vi.stubGlobal("fetch", fetchMock)
  return { posted, fetchMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function fieldValue(p: Posted, name: string): string | undefined {
  return p.payload.embeds[0].fields.find((f) => f.name === name)?.value
}

const withWebhook = { DISCORD_FEEDBACK_WEBHOOK_URL: WEBHOOK } as Partial<Env>

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
      new File([opts.screenshot.bytes], opts.screenshot.name ?? "shot.png", {
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
  it("posts the message, user id and context to the Discord channel", async () => {
    const jwt = await signedInUser("fb-basic")
    const discord = mockDiscord()

    const res = await submit({
      description: "The editor eats my first keystroke.",
      route: "/project/p1/file/f1",
      projectId: "p1",
      fileId: "f1",
      sessionReplayUrl: "https://posthog.example/replay/abc",
      jwt,
      overrides: withWebhook,
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; delivered: boolean; screenshotKey: null }
    expect(body.ok).toBe(true)
    expect(body.delivered).toBe(true)
    expect(body.screenshotKey).toBeNull()

    expect(discord.posted).toHaveLength(1)
    const post = discord.posted[0]
    expect(post.url).toBe(WEBHOOK)
    const embed = post.payload.embeds[0]
    expect(embed.title).toContain("fb-basic")
    expect(embed.description).toBe("The editor eats my first keystroke.")
    expect(fieldValue(post, "User")).toMatch(/fb-basic \(id \d+\)/)
    expect(fieldValue(post, "User")).toContain("fb-basic@example.com")
    expect(fieldValue(post, "Route")).toBe("/project/p1/file/f1")
    expect(fieldValue(post, "File")).toBe("f1")
    expect(fieldValue(post, "Session replay")).toBe("https://posthog.example/replay/abc")
  })

  it("names the org and project when the reporter can read the project", async () => {
    const jwt = await signedInUser("fb-ctx")
    const userId = nextUserId - 1
    await seedUser(nextUserId++, "fb-ctx-owner")
    const ownerId = nextUserId - 1
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, ?, ?, 'team')",
    )
      .bind(9101, "Wycliffe Test Org", ownerId)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, ?, ?)",
    )
      .bind("fb-ctx-proj", "Burmese NT", 9101, userId)
      .run()
    const discord = mockDiscord()

    const res = await submit({
      description: "Context please.",
      projectId: "fb-ctx-proj",
      jwt,
      overrides: withWebhook,
    })

    expect(res.status).toBe(201)
    const post = discord.posted[0]
    expect(fieldValue(post, "Org")).toBe("Wycliffe Test Org (id 9101)")
    expect(fieldValue(post, "Project")).toBe("Burmese NT (fb-ctx-proj)")
    expect(fieldValue(post, "User")).toContain(`(id ${userId})`)
  })

  it("does not reveal the org or project name of a project the reporter cannot read", async () => {
    const jwt = await signedInUser("fb-nosee")
    await seedUser(nextUserId++, "fb-nosee-owner")
    const ownerId = nextUserId - 1
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, ?, ?, 'team')",
    )
      .bind(9102, "Secret Org", ownerId)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, ?, ?)",
    )
      .bind("fb-secret-proj", "Secret Project", 9102, ownerId)
      .run()
    const discord = mockDiscord()

    const res = await submit({
      description: "Probing.",
      projectId: "fb-secret-proj",
      jwt,
      overrides: withWebhook,
    })

    expect(res.status).toBe(201)
    const card = JSON.stringify(discord.posted[0].payload)
    expect(card).not.toContain("Secret Org")
    expect(card).not.toContain("Secret Project")
    // The id the user themselves sent is still shown.
    expect(fieldValue(discord.posted[0], "Project")).toBe("fb-secret-proj")
  })

  it("names the org when the reporter is on one of their org pages, with no project", async () => {
    const jwt = await signedInUser("fb-orgpage")
    const userId = nextUserId - 1
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, ?, ?, 'team')",
    )
      .bind(9103, "Member Org", userId)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, 700, ?)",
    )
      .bind(9103, userId, userId)
      .run()
    const discord = mockDiscord()

    await submit({ description: "Cannot add a member.", route: "/orgs/9103/members", jwt, overrides: withWebhook })

    expect(fieldValue(discord.posted[0], "Org")).toBe("Member Org (id 9103)")
    expect(fieldValue(discord.posted[0], "Project")).toBeUndefined()
    expect(fieldValue(discord.posted[0], "Route")).toBe("/orgs/9103/members")
  })

  it("does not name an org the reporter does not belong to", async () => {
    const jwt = await signedInUser("fb-orgnot")
    await seedUser(nextUserId++, "fb-orgnot-owner")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, ?, ?, 'team')",
    )
      .bind(9104, "Not Yours Org", nextUserId - 1)
      .run()
    const discord = mockDiscord()

    await submit({ description: "Poking.", route: "/orgs/9104", jwt, overrides: withWebhook })

    expect(JSON.stringify(discord.posted[0].payload)).not.toContain("Not Yours Org")
    expect(fieldValue(discord.posted[0], "Org")).toMatch(/^none/)
  })

  it("says there is no org when the report did not come from inside a project", async () => {
    const jwt = await signedInUser("fb-noproj")
    const discord = mockDiscord()
    await submit({ description: "From the home page.", route: "/", jwt, overrides: withWebhook })
    expect(fieldValue(discord.posted[0], "Org")).toMatch(/^none/)
    expect(fieldValue(discord.posted[0], "Project")).toBeUndefined()
  })

  it("attaches the screenshot and archives it in R2 under the key on the card", async () => {
    const jwt = await signedInUser("fb-shot")
    const discord = mockDiscord()
    const bucket = new FakeBucket()

    const res = await submit({
      description: "Look at this layout.",
      route: "/org",
      screenshot: { bytes: PNG_BYTES, type: "image/png" },
      jwt,
      overrides: { ...withWebhook, SNAPSHOTS: bucket as unknown as R2Bucket },
    })

    expect(res.status).toBe(201)
    const { screenshotKey } = (await res.json()) as { screenshotKey: string }
    expect(screenshotKey).toMatch(/^feedback\/\d+\/[0-9a-f-]{36}\.png$/)

    // The seam: bytes land under exactly the key the team is told to look up,
    // and the same bytes ride along as the inline attachment.
    expect(bucket.store.get(screenshotKey)).toEqual(PNG_BYTES)
    const post = discord.posted[0]
    expect(post.payload.embeds[0].footer?.text).toContain(screenshotKey)
    expect(post.payload.embeds[0].image?.url).toBe("attachment://screenshot.png")
    const file = post.files["files[0]"]
    expect(file.name).toBe("screenshot.png")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it("still attaches the image, and says it was not archived, when object storage is unbound", async () => {
    const jwt = await signedInUser("fb-nostore")
    const discord = mockDiscord()

    const res = await submit({
      description: "Storage is down but I still need help.",
      screenshot: { bytes: PNG_BYTES, type: "image/png" },
      jwt,
      overrides: withWebhook,
    })

    expect(res.status).toBe(201)
    expect(((await res.json()) as { screenshotKey: null }).screenshotKey).toBeNull()
    expect(discord.posted).toHaveLength(1)
    expect(discord.posted[0].payload.embeds[0].description).toContain("Storage is down")
    expect(fieldValue(discord.posted[0], "Screenshot")).toMatch(/object storage was unavailable/i)
    expect(discord.posted[0].files["files[0]"]).toBeDefined()
  })

  it("still delivers the message when the R2 put throws", async () => {
    const jwt = await signedInUser("fb-putfail")
    const discord = mockDiscord()
    const bucket = new FakeBucket()
    bucket.putFailure = new Error("R2 exploded")

    const res = await submit({
      description: "Upload will fail.",
      screenshot: { bytes: PNG_BYTES, type: "image/png" },
      jwt,
      overrides: { ...withWebhook, SNAPSHOTS: bucket as unknown as R2Bucket },
    })

    expect(res.status).toBe(201)
    expect(discord.posted).toHaveLength(1)
    expect(fieldValue(discord.posted[0], "Screenshot")).toMatch(/object storage was unavailable/i)
  })

  it("sends a description over the embed limit in full as a text attachment", async () => {
    const jwt = await signedInUser("fb-longtext")
    const discord = mockDiscord()
    const text = "word ".repeat(900).trim() // 4499 chars: under the route cap, over the embed cap

    const res = await submit({ description: text, jwt, overrides: withWebhook })

    expect(res.status).toBe(201)
    const post = discord.posted[0]
    expect(post.payload.embeds[0].description.length).toBeLessThanOrEqual(4096)
    expect(post.payload.embeds[0].description).toContain("description.txt")
    expect(await post.files["files[0]"].text()).toBe(text)
  })

  it("does not let a description ping @everyone", async () => {
    const jwt = await signedInUser("fb-mention")
    const discord = mockDiscord()
    await submit({ description: "@everyone help", jwt, overrides: withWebhook })
    expect(discord.posted[0].payload.allowed_mentions).toEqual({ parse: [] })
  })

  it("accepts the report with delivered:false when no webhook is configured", async () => {
    const jwt = await signedInUser("fb-nohook")
    const discord = mockDiscord()
    const res = await submit({ description: "Local dev report.", jwt })

    expect(res.status).toBe(201)
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(false)
    expect(discord.fetchMock).not.toHaveBeenCalled()
  })

  it("reports a delivery failure rather than claiming success, without leaking the webhook URL", async () => {
    const jwt = await signedInUser("fb-hookfail")
    mockDiscord(500)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await submit({ description: "This post will fail.", jwt, overrides: withWebhook })

    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain("secret-token")
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain("secret-token")
    errSpy.mockRestore()
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
