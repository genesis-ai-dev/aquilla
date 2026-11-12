import { describe, expect, it } from "vitest"
import { scrubRefusal } from "./neon-scrub-guard"

// AQU-1775: the scrub exists to strip production's integration tokens out of
// a COPY of production. The one thing it must never do is run on production.
describe("neon-scrub-integrations refuses the wrong database", () => {
  it("refuses production under every alias, and an unnamed target", () => {
    expect(scrubRefusal("production")).toMatch(/refusing/)
    expect(scrubRefusal("prod")).toMatch(/refusing/)
    expect(scrubRefusal("main")).toMatch(/refusing/)
    expect(scrubRefusal(" Production ")).toMatch(/refusing/)
    expect(scrubRefusal(undefined)).toMatch(/AQUILLA_NEON_TARGET is unset/)
    expect(scrubRefusal("")).toMatch(/AQUILLA_NEON_TARGET is unset/)
  })

  it("allows the refreshable targets", () => {
    expect(scrubRefusal("dev")).toBeNull()
    expect(scrubRefusal("local")).toBeNull()
  })
})
