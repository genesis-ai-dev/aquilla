// POST /api/v2/contact/newsletter — the public partner-letter request form.
// Contract mirrors book-call (contact.test.ts): valid requests are forwarded
// to the team inbox (CONTACT_EMAIL, default joel@frontierrnd.com) with
// Reply-To set to the requester; the honeypot swallows bot submissions
// without sending; a missing EMAIL binding (local/e2e) still returns 200; the
// per-IP throttle is SHARED with book-call (kind "contact" — same inbox, one
// cap). Organization is required — the list is curated.

import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import app from "../index"
import type { Env } from "../types"
import { CONTACT_MAX_PER_IP } from "../utils/rate-limit"

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
  return { binding: { send } as unknown as Env["EMAIL"], sent, send }
}

async function submit(
  body: Record<string, unknown>,
  overrides: Partial<Env> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    "/api/v2/contact/newsletter",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    { ...env, ...overrides },
  )
}

describe("POST /api/v2/contact/newsletter", () => {
  it("forwards the request to the team inbox with Reply-To the requester", async () => {
    const email = makeEmailMock()
    const res = await submit(
      {
        name: "Mariette du Toit",
        email: "mariette@example.com",
        organization: "Biblica",
        message: "We run the Global Publishing translation projects.",
      },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "198.51.100.10" },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, delivered: true })
    expect(email.sent).toHaveLength(1)
    const msg = email.sent[0]
    expect(msg.to).toEqual(["joel@frontierrnd.com"])
    expect(msg.replyTo).toBe("mariette@example.com")
    expect(msg.subject).toContain("Mariette du Toit")
    expect(msg.subject).toContain("Biblica")
    expect(msg.html).toContain("mariette@example.com")
    expect(msg.text).toContain("Global Publishing")
  })

  it("escapes requester-controlled HTML in the notification body", async () => {
    const email = makeEmailMock()
    await submit(
      {
        name: "<script>alert(1)</script>",
        email: "xss@example.com",
        organization: "<img src=x onerror=alert(1)>",
      },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "198.51.100.11" },
    )
    const html = email.sent[0].html
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;")
  })

  it("swallows honeypot submissions with a quiet 200 and no send", async () => {
    const email = makeEmailMock()
    const res = await submit(
      {
        name: "Bot",
        email: "bot@example.com",
        organization: "Botfarm",
        website: "https://spam.example",
      },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "198.51.100.12" },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, delivered: false })
    expect(email.send).not.toHaveBeenCalled()
  })

  it("still returns 200 (delivered: false) when the EMAIL binding is absent", async () => {
    const res = await submit(
      { name: "Local Dev", email: "dev@example.com", organization: "Devs" },
      { EMAIL: undefined },
      { "CF-Connecting-IP": "198.51.100.13" },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, delivered: false })
  })

  it("rejects a missing organization with 400 — the list is curated", async () => {
    const email = makeEmailMock()
    const res = await submit(
      { name: "No Org", email: "noorg@example.com" },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "198.51.100.14" },
    )
    expect(res.status).toBe(400)
    expect(email.send).not.toHaveBeenCalled()
  })

  it("rejects an invalid email with 400", async () => {
    const res = await submit(
      { name: "Bad Email", email: "not-an-email", organization: "Org" },
      {},
      { "CF-Connecting-IP": "198.51.100.15" },
    )
    expect(res.status).toBe(400)
  })

  it("returns 502 when a configured send fails", async () => {
    const failing = {
      send: vi.fn(async () => {
        throw new Error("E_SENDER_NOT_VERIFIED")
      }),
    } as unknown as Env["EMAIL"]
    const res = await submit(
      { name: "Carol", email: "carol@example.com", organization: "Org" },
      { EMAIL: failing },
      { "CF-Connecting-IP": "198.51.100.16" },
    )
    expect(res.status).toBe(502)
  })

  it("shares the per-IP throttle window with book-call (kind \"contact\")", async () => {
    const email = makeEmailMock()
    const ip = { "CF-Connecting-IP": "198.51.100.99" }
    for (let i = 0; i < CONTACT_MAX_PER_IP; i++) {
      const res = await submit(
        { name: `Requester ${i}`, email: `r${i}@example.com`, organization: "Org" },
        { EMAIL: email.binding },
        ip,
      )
      expect(res.status).toBe(200)
    }
    const throttled = await submit(
      { name: "One Too Many", email: "extra@example.com", organization: "Org" },
      { EMAIL: email.binding },
      ip,
    )
    expect(throttled.status).toBe(429)
    expect(email.sent).toHaveLength(CONTACT_MAX_PER_IP)

    // The same window also throttles book-call from that IP — shared cap.
    const bookCall = await app.request(
      "/api/v2/contact/book-call",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ip },
        body: JSON.stringify({ name: "Same IP", email: "same@example.com" }),
      },
      { ...env, EMAIL: email.binding },
    )
    expect(bookCall.status).toBe(429)
  })
})
