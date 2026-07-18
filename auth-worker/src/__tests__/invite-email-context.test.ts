// AQU-471 regression guard: invite emails must surface the inviter and the
// org/project context (the Biblica pilot's #1 ask — "mention the org and who
// invited me"), with a generic fallback when the inviter is unknown, and with
// user-controlled names HTML-escaped in the body.
import { describe, it, expect } from "vitest"
import { buildProjectInviteEmail, buildOrgInviteEmail } from "../services/email"

const JOIN = "https://aquilla.app/join/abc123"
const JOIN_ORG = "https://aquilla.app/join-org/abc123"

describe("buildProjectInviteEmail (AQU-471 invite context)", () => {
  it("names the inviter and the org in subject, html, and text", () => {
    const { subject, html, text } = buildProjectInviteEmail(JOIN, "John", {
      invitedBy: "Prabhu",
      orgName: "Biblica",
    })
    expect(subject).toBe("Prabhu invited you to John in Biblica")
    expect(html).toContain("<strong>Prabhu</strong>")
    expect(html).toContain("<strong>John</strong>")
    expect(html).toContain("<strong>Biblica</strong>")
    expect(text).toBe("Prabhu invited you to John in Biblica. Accept: " + JOIN)
    expect(text).toContain(JOIN)
  })

  it("names the inviter without an org when the project has none", () => {
    const { subject, html } = buildProjectInviteEmail(JOIN, "John", {
      invitedBy: "Prabhu",
    })
    expect(subject).toBe("Prabhu invited you to John")
    expect(html).toContain("<strong>Prabhu</strong>")
    expect(html).not.toContain(" in <strong>")
  })

  it("falls back to generic copy when the inviter is unknown", () => {
    const { subject, html, text } = buildProjectInviteEmail(JOIN, "John")
    expect(subject).toBe("You've been invited to John")
    expect(html).toContain("You've been invited to collaborate on <strong>John</strong>")
    expect(html).not.toContain("invited you to collaborate")
    expect(text).toBe("You've been invited to John. Accept: " + JOIN)
  })

  it("treats a blank inviter as unknown (generic fallback)", () => {
    const { subject } = buildProjectInviteEmail(JOIN, "John", { invitedBy: "  " })
    expect(subject).toBe("You've been invited to John")
  })

  it("HTML-escapes an attacker-influenced inviter name in the body", () => {
    const { html } = buildProjectInviteEmail(JOIN, "John", {
      invitedBy: "<script>x</script>",
      orgName: "A & B <Org>",
    })
    expect(html).not.toContain("<script>x</script>")
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;")
    expect(html).toContain("A &amp; B &lt;Org&gt;")
  })
})

describe("buildOrgInviteEmail (AQU-471 invite context)", () => {
  it("names the inviter in subject, html, and text", () => {
    const { subject, html, text } = buildOrgInviteEmail(JOIN_ORG, "Biblica", {
      invitedBy: "Prabhu",
    })
    expect(subject).toBe("Prabhu invited you to join Biblica")
    expect(html).toContain("<strong>Prabhu</strong>")
    expect(html).toContain("<strong>Biblica</strong>")
    expect(text).toBe("Prabhu invited you to join Biblica on Aquilla. Join: " + JOIN_ORG)
  })

  it("falls back to generic copy when the inviter is unknown", () => {
    const { subject, html } = buildOrgInviteEmail(JOIN_ORG, "Biblica")
    expect(subject).toBe("You've been invited to join Biblica")
    expect(html).toContain("You've been invited to join the <strong>Biblica</strong> organization")
    expect(html).not.toContain("invited you to join the")
  })

  it("HTML-escapes an attacker-influenced inviter name in the body", () => {
    const { html } = buildOrgInviteEmail(JOIN_ORG, "Biblica", {
      invitedBy: "<b>evil</b>",
    })
    expect(html).not.toContain("<b>evil</b>")
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;")
  })
})
