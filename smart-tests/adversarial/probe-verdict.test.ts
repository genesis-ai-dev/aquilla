import { describe, expect, it } from "vitest"
import type { Contract, Snapshot } from "./invariants"
import { probeOutcome } from "./probe-verdict"

const snapshot = (value: string, validators: string[] = []): Snapshot => ({
  projects: [{ id: "p", name: "Project", present: true }],
  files: [{ projectId: "p", fileId: "f", name: "a.md", deleted: false }],
  cells: [{ fileId: "f", cellId: "c1", side: "target", value, validated: validators.length > 0, eventId: `e-${value}` }],
  comments: [], histories: {}, validators: { c1: validators },
})
const untouched: Contract = { allowed: [], required: [] }
const refused = [{ what: "viewer empties every translation", status: 403 }]

describe("red-team probe verdict", () => {
  it("passes when the server refused the write and the same write works for the owner", () => {
    expect(probeOutcome(snapshot("kept"), snapshot("kept"), untouched, refused, true).verdict).toBe("passed")
  })

  it("is a product failure when a hostile write changed stored state", () => {
    // The finding the probes exist for: a viewer's write that the server kept.
    const outcome = probeOutcome(snapshot("kept"), snapshot(""), untouched, [{ what: "viewer empties every translation", status: 200 }], true)
    expect(outcome.verdict).toBe("product_failure")
    expect(outcome.diffs).toEqual(["cell f/c1/target changed"])
  })

  it("is a product failure when the refusal was a server error, even though nothing changed", () => {
    // A refusal is a 4xx. A 5xx means the hostile request reached code that crashed on it.
    const outcome = probeOutcome(snapshot("kept"), snapshot("kept"), untouched, [{ what: "rename to an empty name", status: 500 }], true)
    expect(outcome.verdict).toBe("product_failure")
    expect(outcome.checks.noServerErrors).toBe(false)
  })

  it("never passes when the control did not land: an unchanged file then proves nothing", () => {
    // The empty pass this replaces: "nothing changed" with no evidence the request could ever have worked.
    const outcome = probeOutcome(snapshot("kept"), snapshot("kept"), untouched, refused, false)
    expect(outcome.verdict).toBe("inconclusive")
    expect(outcome.reason).toContain("the control request did not land")
  })

  it("never passes when no hostile request was sent", () => {
    expect(probeOutcome(snapshot("kept"), snapshot("kept"), untouched, [], true).verdict).toBe("inconclusive")
  })

  it("is a product failure when one reviewer is stored twice for one translation", () => {
    const contract: Contract = { allowed: [{ kind: "validation", cellId: "c1" }], required: [{ kind: "no-duplicate-validation", cellId: "c1" }] }
    const sent = [{ what: "first sign-off", status: 200 }, { what: "second sign-off of the same translation", status: 200 }]
    expect(probeOutcome(snapshot("kept"), snapshot("kept", ["adv-bot-1", "adv-bot-1"]), contract, sent, true).verdict).toBe("product_failure")
    expect(probeOutcome(snapshot("kept"), snapshot("kept", ["adv-bot-1"]), contract, sent, true).verdict).toBe("passed")
  })
})
