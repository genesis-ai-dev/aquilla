// POST /api/v2/contact/book-call — the public marketing "book a call" form.
// Contract: valid submissions are forwarded to the team inbox (CONTACT_EMAIL,
// default joel@frontierrnd.com) with Reply-To set to the visitor; the honeypot
// swallows bot submissions without sending; a missing EMAIL binding (local/e2e)
// still returns 200 so the dev form works; per-IP throttle caps submissions.

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
    "/api/v2/contact/book-call",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    { ...env, ...overrides },
  )
}

describe("POST /api/v2/contact/book-call", () => {
  it("forwards the submission to the default team inbox with Reply-To the visitor", async () => {
    const email = makeEmailMock()
    const res = await submit(
      {
        name: "Ada Lovelace",
        email: "ada@example.com",
        organization: "Analytical Engines Ltd",
        message: "We'd like to translate our docs.",
      },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "203.0.113.10" },
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, delivered: true })
    expect(email.sent).toHaveLength(1)
    const msg = email.sent[0]
    expect(msg.to).toEqual(["joel@frontierrnd.com"])
    expect(msg.replyTo).toBe("ada@example.com")
    expect(msg.subject).toContain("Ada Lovelace")
    expect(msg.html).toContain("ada@example.com")
    expect(msg.html).toContain("Analytical Engines Ltd")
    expect(msg.text).toContain("We'd like to translate our docs.")
  })

  it("honors a CONTACT_EMAIL override", async () => {
    const email = makeEmailMock()
    const res = await submit(
      { name: "Bob", email: "bob@example.com" },
      { EMAIL: email.binding, CONTACT_EMAIL: "team@example.org" },
      { "CF-Connecting-IP": "203.0.113.11" },
    )
    expect(res.status).toBe(200)
    expect(email.sent[0].to).toEqual(["team@example.org"])
  })

  it("escapes visitor-controlled HTML in the notification body", async () => {
    const email = makeEmailMock()
    await submit(
      {
        name: "<script>alert(1)</script>",
        email: "xss@example.com",
        message: "<img src=x onerror=alert(1)>",
      },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "203.0.113.12" },
    )
    const html = email.sent[0].html
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;")
  })

  it("swallows honeypot submissions with a quiet 200 and no send", async () => {
    const email = makeEmailMock()
    const res = await submit(
      { name: "Bot", email: "bot@example.com", website: "https://spam.example" },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "203.0.113.13" },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, delivered: false })
    expect(email.send).not.toHaveBeenCalled()
  })

  it("still returns 200 (delivered: false) when the EMAIL binding is absent", async () => {
    const res = await submit(
      { name: "Local Dev", email: "dev@example.com" },
      { EMAIL: undefined },
      { "CF-Connecting-IP": "203.0.113.14" },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, delivered: false })
  })

  it("rejects an invalid email with 400", async () => {
    const email = makeEmailMock()
    const res = await submit(
      { name: "No Email", email: "not-an-email" },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "203.0.113.15" },
    )
    expect(res.status).toBe(400)
    expect(email.send).not.toHaveBeenCalled()
  })

  it("rejects a missing name with 400", async () => {
    const res = await submit(
      { name: "", email: "a@example.com" },
      {},
      { "CF-Connecting-IP": "203.0.113.16" },
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
      { name: "Carol", email: "carol@example.com" },
      { EMAIL: failing },
      { "CF-Connecting-IP": "203.0.113.17" },
    )
    expect(res.status).toBe(502)
  })

  it("throttles a single IP past the per-window cap", async () => {
    const email = makeEmailMock()
    const ip = { "CF-Connecting-IP": "203.0.113.99" }
    for (let i = 0; i < CONTACT_MAX_PER_IP; i++) {
      const res = await submit(
        { name: `Visitor ${i}`, email: `v${i}@example.com` },
        { EMAIL: email.binding },
        ip,
      )
      expect(res.status).toBe(200)
    }
    const throttled = await submit(
      { name: "One Too Many", email: "extra@example.com" },
      { EMAIL: email.binding },
      ip,
    )
    expect(throttled.status).toBe(429)
    expect(email.sent).toHaveLength(CONTACT_MAX_PER_IP)

    // A different IP in the same window is unaffected.
    const other = await submit(
      { name: "Other Visitor", email: "other@example.com" },
      { EMAIL: email.binding },
      { "CF-Connecting-IP": "203.0.113.100" },
    )
    expect(other.status).toBe(200)
  })
})
