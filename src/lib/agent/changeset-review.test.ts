/**
 * changeset-review.test.ts — the pure gating/display rules the AQU-841
 * approvals queue leans on.
 *
 * `requiresPerItemConfirmation` is the rule that decides whether a plan may be
 * bulk-approved (COMMAND-REGISTRY §5: testimony never can). Getting it wrong in
 * either direction is a real failure — too strict and legitimate work can never
 * be cleared from the queue, too loose and a human's quality assertion is
 * swept in by one click — so it is tested here rather than only through the
 * page that renders it.
 */

import { describe, it, expect } from "vitest"
import {
  humanizeSummaryKey,
  requiresPerItemConfirmation,
  summaryFactEntries,
} from "./changeset-review"

describe("requiresPerItemConfirmation (COMMAND-REGISTRY §5)", () => {
  it("holds back a summary whose events carry the server's testimony mark", () => {
    expect(
      requiresPerItemConfirmation({
        events: [{ kind: "cell.validate", count: 2, testimony: true }],
      }),
    ).toBe(true)
  })

  it("holds back a testimony KIND even on a summary staged before the mark existed", () => {
    expect(requiresPerItemConfirmation({ events: [{ kind: "cell.unvalidate", count: 1 }] })).toBe(
      true,
    )
  })

  it("holds back a mixed plan — one testimony event taints the whole changeset", () => {
    expect(
      requiresPerItemConfirmation({
        events: [
          { kind: "target.cell.commit", count: 9 },
          { kind: "cell.validate", count: 1 },
        ],
      }),
    ).toBe(true)
  })

  it("lets prepared-tier work through", () => {
    expect(
      requiresPerItemConfirmation({
        events: [
          { kind: "target.cell.commit", count: 3 },
          { kind: "comment.create", count: 1 },
        ],
      }),
    ).toBe(false)
  })

  it("lets an un-itemized summary through — the /approve gate never blocked it", () => {
    expect(requiresPerItemConfirmation({ translationsAdded: 4 })).toBe(false)
    expect(requiresPerItemConfirmation({})).toBe(false)
  })
})

describe("summaryFactEntries", () => {
  it("keeps the scalar facts and drops the blocks the caller renders itself", () => {
    expect(
      summaryFactEntries({
        translationsAdded: 3,
        note: "two files",
        warnings: [{ message: "term drift" }],
        settingsChanges: { "llm.model": "…" },
        events: [{ kind: "target.cell.commit", count: 3 }],
      }),
    ).toEqual([
      ["translationsAdded", 3],
      ["note", "two files"],
    ])
  })

  it("drops values that are neither string nor number rather than stringifying them", () => {
    expect(summaryFactEntries({ ok: 1, nested: { a: 1 }, flag: true })).toEqual([["ok", 1]])
  })
})

describe("humanizeSummaryKey", () => {
  it("reads camelCase and snake_case the same way", () => {
    expect(humanizeSummaryKey("translationsAdded")).toBe("Translations added")
    expect(humanizeSummaryKey("translations_added")).toBe("Translations added")
  })
})
