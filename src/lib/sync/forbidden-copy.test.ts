// AQU-633: reason→copy mapping for 403 refusals surfaced to the user.
import { describe, it, expect } from "vitest"
import { forbiddenReasonCopy, forbiddenBannerMessage } from "./forbidden-copy"
import type { ForbiddenEntry } from "./outbox-flush"

function entry(reason: string, over: Partial<ForbiddenEntry> = {}): ForbiddenEntry {
  return { id: "e", status: 403, reason, kind: "cell.validate", fileId: "f", cellId: "c", ...over }
}

describe("forbiddenReasonCopy", () => {
  it("maps a file-scope refusal", () => {
    expect(forbiddenReasonCopy("file 'f1' not in scope for cell.validate")).toMatch(
      /file was outside your assigned scope/i,
    )
  })
  it("maps a lane-scope refusal", () => {
    expect(forbiddenReasonCopy("lane 'es' not in scope for cell.validate")).toMatch(
      /language lane was outside your assigned scope/i,
    )
  })
  it("maps a self-validation refusal", () => {
    expect(forbiddenReasonCopy("self-validation is not allowed on this project")).toMatch(
      /self-validation was off for this project at the time/i,
    )
  })
  it("maps a role-floor refusal", () => {
    expect(forbiddenReasonCopy("role too low to validate (project requires project_lead or above)")).toMatch(
      /role wasn't allowed to validate/i,
    )
  })
  it("maps an allowlist refusal", () => {
    expect(forbiddenReasonCopy("user 'bob' is not in the project's validator allowlist")).toMatch(
      /weren't on this project's validator allowlist/i,
    )
  })
  it("falls back to the raw reason for an unmapped message", () => {
    expect(forbiddenReasonCopy("some brand new server reason")).toBe("some brand new server reason")
  })
})

describe("forbiddenBannerMessage", () => {
  it("reports the count and the dominant reason", () => {
    const msg = forbiddenBannerMessage([
      entry("file 'f1' not in scope for cell.validate"),
      entry("file 'f1' not in scope for cell.validate"),
    ])
    expect(msg).toMatch(/2 changes weren't saved/i)
    expect(msg).toMatch(/file was outside your assigned scope/i)
  })
  it("uses the singular for one entry", () => {
    expect(forbiddenBannerMessage([entry("self-validation is not allowed on this project")])).toMatch(
      /1 change wasn't saved/i,
    )
  })
  it("returns empty string for no entries", () => {
    expect(forbiddenBannerMessage([])).toBe("")
  })
})
