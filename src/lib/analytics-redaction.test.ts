import { describe, it, expect } from "vitest"
import {
  REDACTED,
  isUrlLikeKey,
  redactAnalyticsProperties,
  redactCaptureEvent,
  redactUrlLike,
} from "./analytics-redaction"

describe("redactUrlLike", () => {
  it("redacts the invite token in a /join path", () => {
    expect(redactUrlLike("https://aquilla.app/join/8f3c1d2e-invite-token")).toBe(
      `https://aquilla.app/join/${REDACTED}`,
    )
  })

  it("redacts /join-org and /link tokens too", () => {
    expect(redactUrlLike("/join-org/org-invite-token")).toBe(`/join-org/${REDACTED}`)
    expect(redactUrlLike("/link/per-user-access-token")).toBe(`/link/${REDACTED}`)
  })

  it("redacts the password-reset token and the username beside it", () => {
    expect(
      redactUrlLike("https://aquilla.app/reset-password?token=reset-secret&username=ada"),
    ).toBe(`https://aquilla.app/reset-password?token=${REDACTED}&username=${REDACTED}`)
  })

  it("redacts the email-verification token", () => {
    expect(redactUrlLike("/verify-email?token=verify-secret")).toBe(
      `/verify-email?token=${REDACTED}`,
    )
  })

  it("redacts the ?t= sync token used by media URLs", () => {
    expect(redactUrlLike("https://sync.aquilla.app/audio/p/f/a.webm?t=jwt.jwt.jwt")).toBe(
      `https://sync.aquilla.app/audio/p/f/a.webm?t=${REDACTED}`,
    )
  })

  it("leaves an ordinary URL byte-for-byte unchanged", () => {
    const url = "https://aquilla.app/project/abc/editor?file=gen&cell=GEN%201:1#top"
    expect(redactUrlLike(url)).toBe(url)
    expect(redactUrlLike("/project/abc/editor")).toBe("/project/abc/editor")
  })

  it("keeps the route itself — only the credential segment goes", () => {
    // The fact that someone opened an invite link is analytics; the token is not.
    expect(redactUrlLike("/join/tok?utm_source=email")).toBe(
      `/join/${REDACTED}?utm_source=email`,
    )
  })

  it("handles empty, bare and unparseable values without throwing", () => {
    expect(redactUrlLike("")).toBe("")
    expect(redactUrlLike("/join/")).toBe("/join/")
    expect(redactUrlLike("not a url at all")).toBe("not a url at all")
  })
})

describe("isUrlLikeKey", () => {
  it("matches the PostHog URL properties and our own route property", () => {
    for (const key of [
      "$current_url",
      "$pathname",
      "$referrer",
      "$initial_current_url",
      "$initial_pathname",
      "$initial_referrer",
      "$session_entry_url",
      "$prev_pageview_pathname",
      "route",
    ]) {
      expect(isUrlLikeKey(key)).toBe(true)
    }
  })

  it("does not match unrelated properties", () => {
    for (const key of ["project_id", "$referring_domain", "description", "file_exts"]) {
      expect(isUrlLikeKey(key)).toBe(false)
    }
  })
})

describe("redactAnalyticsProperties", () => {
  it("redacts URL-shaped properties and passes everything else through", () => {
    const out = redactAnalyticsProperties({
      $current_url: "https://aquilla.app/link/access-token",
      $pathname: "/link/access-token",
      project_id: "p1",
      description: "the /link/access-token page broke",
      count: 3,
    })
    expect(out.$current_url).toBe(`https://aquilla.app/link/${REDACTED}`)
    expect(out.$pathname).toBe(`/link/${REDACTED}`)
    // Non-URL properties are untouched — this pass is about the properties the
    // library attaches by itself, not about censoring user-authored text.
    expect(out.project_id).toBe("p1")
    expect(out.description).toBe("the /link/access-token page broke")
    expect(out.count).toBe(3)
  })

  it("redacts the href rrweb stamps onto a replay snapshot", () => {
    const out = redactAnalyticsProperties({
      $snapshot_data: [
        { type: 4, data: { href: "https://aquilla.app/join/tok", width: 800 } },
        { type: 3, data: { source: 2 } },
      ],
    })
    const snapshot = out.$snapshot_data as { type: number; data: Record<string, unknown> }[]
    expect(snapshot[0]!.data.href).toBe(`https://aquilla.app/join/${REDACTED}`)
    expect(snapshot[0]!.data.width).toBe(800)
    expect(snapshot[1]!.data.source).toBe(2)
  })
})

describe("redactCaptureEvent", () => {
  it("covers properties, $set and $set_once", () => {
    const out = redactCaptureEvent({
      event: "$pageview",
      properties: { $current_url: "https://aquilla.app/reset-password?token=s3cret" },
      $set: { $current_url: "https://aquilla.app/reset-password?token=s3cret" },
      $set_once: { $initial_current_url: "https://aquilla.app/join/tok" },
    })
    expect(out?.properties?.$current_url).toBe(
      `https://aquilla.app/reset-password?token=${REDACTED}`,
    )
    expect(out?.$set?.$current_url).toBe(`https://aquilla.app/reset-password?token=${REDACTED}`)
    expect(out?.$set_once?.$initial_current_url).toBe(`https://aquilla.app/join/${REDACTED}`)
  })

  it("never drops an event", () => {
    const event = { event: "user logged in", properties: { project_id: "p1" } }
    expect(redactCaptureEvent(event)).toEqual(event)
    expect(redactCaptureEvent(null)).toBeNull()
  })
})
