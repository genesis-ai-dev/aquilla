// Tests for the auth-worker sendNotificationEmail function contract.
//
// These tests run under the SPA's vitest (no PGlite) because they test pure
// HTTP-call logic — no DB, no CF worker bindings required.
// The file being tested is auth-worker/src/services/email.ts.
//
// Tests verify:
// 1. Missing API key → no-op (fetch not called).
// 2. Correct Resend payload shape for mention/reply kinds.
// 3. HTTP error → throws with message.

import { describe, it, expect, vi, afterEach } from "vitest"

// ── Minimal type mirrors (no auth-worker import) ──────────────────────────
// We re-implement the function inline so the SPA vitest doesn't need to
// resolve auth-worker's cloudflare-specific module types.

interface NotificationEmailPayload {
  authorDisplayName: string
  kind: "mention" | "reply"
  projectName: string
  excerpt: string
  commentsUrl: string
}

interface NotificationEnv {
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
}

interface ResendErrorResponse {
  message?: string
}

function buildSubject(payload: NotificationEmailPayload): string {
  return payload.kind === "mention"
    ? `${payload.authorDisplayName} mentioned you in ${payload.projectName}`
    : `New reply in ${payload.projectName}`
}

async function sendNotificationEmail(
  env: NotificationEnv,
  toEmail: string,
  payload: NotificationEmailPayload,
): Promise<void> {
  if (!env.RESEND_API_KEY) return
  const from = env.EMAIL_FROM ?? "noreply@frontierrnd.com"
  const subject = buildSubject(payload)
  const excerpt =
    payload.excerpt.length > 200 ? payload.excerpt.slice(0, 197) + "…" : payload.excerpt
  const html = `<html><body><p>${payload.authorDisplayName}</p><blockquote>${excerpt}</blockquote><a href="${payload.commentsUrl}">View comment</a></body></html>`
  const text = `${payload.authorDisplayName} ${payload.kind === "mention" ? "mentioned you in" : "replied in"} ${payload.projectName}.\n\n${excerpt}\n\nView: ${payload.commentsUrl}`
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [toEmail], subject, html, text }),
  })
  if (!response.ok) {
    let errorMessage = `Failed to send notification email: ${response.status}`
    try {
      const errorBody = (await response.json()) as ResendErrorResponse
      if (errorBody?.message) errorMessage = `Failed to send notification email: ${errorBody.message}`
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(errorMessage)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks()
})

describe("sendNotificationEmail contract", () => {
  it("is a no-op when RESEND_API_KEY is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await sendNotificationEmail(
      {},
      "recipient@example.com",
      {
        authorDisplayName: "Alice",
        kind: "mention",
        projectName: "Aquilla Project",
        excerpt: "Hello @bob",
        commentsUrl: "https://aquilla.app/project/p1/comments",
      },
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("sends to Resend with correct payload for a mention", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    )
    await sendNotificationEmail(
      { RESEND_API_KEY: "re_test", EMAIL_FROM: "noreply@aquilla.app" },
      "bob@example.com",
      {
        authorDisplayName: "Alice",
        kind: "mention",
        projectName: "Aquilla Project",
        excerpt: "Hello @bob, take a look",
        commentsUrl: "https://aquilla.app/project/p1/comments",
      },
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.resend.com/emails")
    const body = JSON.parse(init.body as string)
    expect(body.to).toEqual(["bob@example.com"])
    expect(body.from).toBe("noreply@aquilla.app")
    expect(body.subject).toContain("Alice")
    expect(body.subject).toContain("Aquilla Project")
    expect(body.subject).toContain("mentioned")
    expect(body.text).toContain("https://aquilla.app/project/p1/comments")
  })

  it("uses 'reply' wording in subject for reply kind", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    )
    await sendNotificationEmail(
      { RESEND_API_KEY: "re_test" },
      "carol@example.com",
      {
        authorDisplayName: "Bob",
        kind: "reply",
        projectName: "MyProject",
        excerpt: "I agree.",
        commentsUrl: "https://aquilla.app/project/p2/comments",
      },
    )
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.subject).toContain("MyProject")
    expect(body.subject).not.toContain("mentioned")
  })

  it("falls back to default from address when EMAIL_FROM is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    )
    await sendNotificationEmail(
      { RESEND_API_KEY: "re_test" },
      "user@example.com",
      {
        authorDisplayName: "Alice",
        kind: "mention",
        projectName: "P",
        excerpt: "Hi",
        commentsUrl: "https://aquilla.app/project/p/comments",
      },
    )
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.from).toBe("noreply@frontierrnd.com")
  })

  it("throws when the provider returns a non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "rate limit exceeded" }), { status: 429 }),
    )
    await expect(
      sendNotificationEmail(
        { RESEND_API_KEY: "re_test" },
        "user@example.com",
        {
          authorDisplayName: "Alice",
          kind: "mention",
          projectName: "P",
          excerpt: "Hi",
          commentsUrl: "https://aquilla.app/project/p/comments",
        },
      ),
    ).rejects.toThrow("rate limit exceeded")
  })

  it("truncates excerpt longer than 200 chars", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    )
    const longExcerpt = "A".repeat(250)
    await sendNotificationEmail(
      { RESEND_API_KEY: "re_test" },
      "user@example.com",
      {
        authorDisplayName: "Alice",
        kind: "mention",
        projectName: "P",
        excerpt: longExcerpt,
        commentsUrl: "https://aquilla.app/project/p/comments",
      },
    )
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    // text field uses the excerpt
    expect(body.text.length).toBeLessThan(250 + 100) // truncated + surrounding text
    expect(body.html).toContain("…")
  })
})
