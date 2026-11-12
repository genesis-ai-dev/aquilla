import { describe, expect, it } from "vitest"
import { shouldPrefetchReferences } from "./prefetch-policy"

describe("shouldPrefetchReferences (AQU-843)", () => {
  it("prefetches when the browser reports nothing", () => {
    // Safari and Firefox expose no Network Information API — the default has to
    // be "on", or the feature silently does nothing for most desktop users.
    expect(shouldPrefetchReferences(null)).toBe(true)
    expect(shouldPrefetchReferences(undefined)).toBe(true)
    expect(shouldPrefetchReferences({})).toBe(true)
  })

  it("prefetches on links that can afford it", () => {
    expect(shouldPrefetchReferences({ effectiveType: "4g", saveData: false })).toBe(true)
    expect(shouldPrefetchReferences({ effectiveType: "3g" })).toBe(true)
  })

  it("honours Data Saver regardless of link speed", () => {
    expect(shouldPrefetchReferences({ saveData: true, effectiveType: "4g" })).toBe(false)
  })

  it("stands down on 2g links, where a preload would starve the visible fetch", () => {
    expect(shouldPrefetchReferences({ effectiveType: "2g" })).toBe(false)
    expect(shouldPrefetchReferences({ effectiveType: "slow-2g" })).toBe(false)
  })

  it("ignores an effectiveType it doesn't recognise rather than failing closed", () => {
    expect(shouldPrefetchReferences({ effectiveType: "5g" })).toBe(true)
  })
})
