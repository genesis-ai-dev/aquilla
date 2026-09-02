import { describe, it, expect, beforeEach } from "vitest"
import {
  requestSourceEdit,
  claimSourceEdit,
  clearSourceEditRequest,
} from "./pending-source-edit"

beforeEach(() => {
  clearSourceEditRequest()
})

describe("pending-source-edit (AQU-888)", () => {
  it("hands the claim to the requested cell", () => {
    requestSourceEdit("cell-a")
    expect(claimSourceEdit("cell-a")).toBe(true)
  })

  it("keeps answering the same row for a moment, so StrictMode's two initializer passes agree", () => {
    const t0 = 1_000_000
    requestSourceEdit("cell-a", t0)
    expect(claimSourceEdit("cell-a", t0)).toBe(true)
    expect(claimSourceEdit("cell-a", t0)).toBe(true)
  })

  it("stops answering once the settle window passes — a later re-mount stays closed", () => {
    const t0 = 1_000_000
    requestSourceEdit("cell-a", t0)
    expect(claimSourceEdit("cell-a", t0)).toBe(true)
    expect(claimSourceEdit("cell-a", t0 + 251)).toBe(false)
  })

  it("collecting never EXTENDS the claim past its own expiry", () => {
    const t0 = 1_000_000
    requestSourceEdit("cell-a", t0)
    // Collected right at the end of the TTL: the settle window must not push
    // the claim past the give-up point the workspace agreed on.
    expect(claimSourceEdit("cell-a", t0 + 7_900)).toBe(true)
    expect(claimSourceEdit("cell-a", t0 + 8_001)).toBe(false)
  })

  it("does not leak to a different row, and leaves the claim for its owner", () => {
    requestSourceEdit("cell-a")
    expect(claimSourceEdit("cell-b")).toBe(false)
    expect(claimSourceEdit("cell-a")).toBe(true)
  })

  it("does not leak to a different row during the settle window either", () => {
    const t0 = 1_000_000
    requestSourceEdit("cell-a", t0)
    expect(claimSourceEdit("cell-a", t0)).toBe(true)
    expect(claimSourceEdit("cell-b", t0)).toBe(false)
  })

  it("expires, so a create that never lands cannot ambush a later row", () => {
    const t0 = 1_000_000
    requestSourceEdit("cell-a", t0)
    expect(claimSourceEdit("cell-a", t0 + 8001)).toBe(false)
    // …and the stale claim is gone rather than merely unreadable.
    expect(claimSourceEdit("cell-a", t0 + 1)).toBe(false)
  })

  it("a second request replaces the first", () => {
    requestSourceEdit("cell-a")
    requestSourceEdit("cell-b")
    expect(claimSourceEdit("cell-a")).toBe(false)
    expect(claimSourceEdit("cell-b")).toBe(true)
  })

  it("claims nothing when none was requested", () => {
    expect(claimSourceEdit("cell-a")).toBe(false)
  })
})
