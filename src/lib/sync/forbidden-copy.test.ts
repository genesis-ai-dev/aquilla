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
      /weren't allowed to work in es/i,
    )
  })
  it("names the language in a lane-scope refusal (AQU-581 review)", () => {
    expect(forbiddenReasonCopy("lane 'Spanish' not in scope for target.cell.commit")).toBe(
      "you weren't allowed to work in Spanish at the time",
    )
    expect(forbiddenReasonCopy("lane '' not in scope for target.cell.commit")).toBe(
      "you weren't allowed to work in the main language at the time",
    )
  })

  it("says EDIT, not validate, when an edit is refused on role (AQU-581 review)", () => {
    expect(forbiddenReasonCopy("role too low for target.cell.commit")).toBe(
      "your role wasn't allowed to edit translations on this project",
    )
    expect(forbiddenReasonCopy("role too low for cell.validate")).toMatch(/validate/)
    expect(forbiddenReasonCopy("role too low for assignment.unassign")).toBe(
      "your role wasn't allowed to make this change on this project",
    )
  })

  it("AQU-1788: never shows the downgrade gate's internal reason verbatim", () => {
    // The flusher re-mints and retries this one, so the banner normally gets
    // the ordinary role floor instead. When a retry is refused on the same
    // grounds, the copy still has to mean something to the person.
    const copy = forbiddenReasonCopy("role downgraded since token was issued")
    expect(copy).not.toMatch(/token/i)
    expect(copy).toBe(
      "your access level changed while you were working, so this change wasn't saved",
    )
  })

  it("maps a self-validation refusal", () => {
    expect(forbiddenReasonCopy("self-validation is not allowed on this project")).toMatch(
      /self-validation was off for this project at the time/i,
    )
  })
  it("maps a vote on an unsaved edit (AQU-1571)", () => {
    expect(forbiddenReasonCopy("validating an edit before it is saved is not allowed on this project")).toBe(
      "the translation hadn't been saved yet, so who wrote it couldn't be checked",
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
  // AQU-1571: the recording refusals, in the past tense like the rest, and
  // naming a RECORDING rather than a translation.
  it("maps the audio validation refusals", () => {
    expect(forbiddenReasonCopy("validating your own recording is not allowed on this project")).toBe(
      "validating your own recording wasn't allowed (self-validation of recordings was off for this project at the time)",
    )
    expect(
      forbiddenReasonCopy("validating a recording before it is saved is not allowed on this project"),
    ).toBe("the recording hadn't been saved yet, so who made it couldn't be checked")
    expect(forbiddenReasonCopy("only a maintainer can remove another user's audio validation")).toBe(
      "only a maintainer could remove someone else's validation",
    )
    expect(forbiddenReasonCopy("role too low to validate audio (project requires maintainer or above)")).toMatch(
      /role wasn't allowed to validate/i,
    )
    expect(forbiddenReasonCopy("user 'bob' is not in the project's audio validator allowlist")).toMatch(
      /weren't on this project's validator allowlist/i,
    )
  })
  it("falls back to the raw reason for an unmapped message", () => {
    expect(forbiddenReasonCopy("some brand new server reason")).toBe("some brand new server reason")
  })

  it("names the lane when a write was refused because it was archived (AQU-1462)", () => {
    expect(forbiddenReasonCopy("lane 'Spanish' is archived")).toBe("the Spanish lane was archived")
    expect(forbiddenBannerMessage([entry("lane 'Spanish' is archived")])).toBe(
      "1 change wasn't saved — the Spanish lane was archived.",
    )
  })

  it("does not name a lane the caller is not allowed to know (AQU-1462)", () => {
    expect(forbiddenReasonCopy("lane does not exist")).toBe("that lane does not exist")
    expect(forbiddenBannerMessage([entry("lane does not exist")])).toBe(
      "1 change wasn't saved — that lane does not exist.",
    )
    expect(forbiddenReasonCopy("lane does not exist")).not.toMatch(/archived|german|spanish/i)
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
