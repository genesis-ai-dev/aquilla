import { describe, it, expect } from "vitest"
import { buildProjectInviteEmail, buildBookCallEmail, oneLine } from "../services/email"

describe("email subject header-injection hardening", () => {
  it("oneLine collapses CR/LF and control chars", () => {
    expect(oneLine("a\r\nBcc: e@x.com\u2028z")).not.toMatch(/[\r\n\u2028]/)
  })
  it("strips CR/LF from user-controlled names in subjects", () => {
    const inv = buildProjectInviteEmail("https://x/j", "Proj\r\nBcc: evil@x.com", { invitedBy: "a\nb" })
    expect(inv.subject).not.toMatch(/[\r\n]/)
    const call = buildBookCallEmail({ name: "N\r\nBcc: e@x.com", email: "a@b.co", message: "m" } as never)
    expect(call.subject).not.toMatch(/[\r\n]/)
  })
})
