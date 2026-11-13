import { describe, expect, it } from "vitest"
import { loginFailure } from "./health"

describe("why a bot account could not sign in", () => {
  it("names the dev access list when the target refused a listed-only sign-in", () => {
    const reason = loginFailure("adv-bot-1", 403, "dev_access_restricted")
    expect(reason).toContain("adv-bot-1 is not on the dev access list")
    expect(reason).toContain("docs/security/preview-access.md")
  })

  it("tells an unreadable list apart from an unlisted account", () => {
    const reason = loginFailure("adv-bot-1", 503, "dev_access_restricted")
    expect(reason).toContain("could not be read")
    expect(reason).not.toContain("is not on the dev access list")
  })

  it("keeps the plain status for every other refusal, such as a wrong password", () => {
    expect(loginFailure("adv-bot-1", 401, undefined)).toBe("login adv-bot-1 failed: HTTP 401")
    expect(loginFailure("adv-bot-1", 403, "something_else")).toBe("login adv-bot-1 failed: HTTP 403")
  })
})
