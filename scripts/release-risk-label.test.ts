import { describe, expect, it } from "vitest"
import { labelDelta } from "./release-risk-label.mjs"

// The labeler runs on every push to a PR. It must converge on exactly the
// areas the diff touches without ever removing a person's sign-off, or a
// re-push would silently take a PR back off the line it was approved for.
describe("labelDelta", () => {
  it("adds the missing risk labels and removes stale ones", () => {
    expect(labelDelta(["risk:auth", "bug"], ["events"])).toEqual({ add: ["risk:events"], remove: ["risk:auth"] })
  })

  it("is a no-op when the labels already match", () => {
    expect(labelDelta(["risk:events", "risk:sync"], ["events", "sync"])).toEqual({ add: [], remove: [] })
  })

  it("never removes release:approved or any non-risk label", () => {
    expect(labelDelta(["release:approved", "on hold", "risk:auth"], [])).toEqual({ add: [], remove: ["risk:auth"] })
  })
})
