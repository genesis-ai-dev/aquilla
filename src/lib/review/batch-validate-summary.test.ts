/**
 * AQU-1503 — regression guard for the bulk text-validation guard branches.
 *
 * The bug this file exists for: both bulk-validate surfaces decided what to
 * emit inline and then said nothing about what they dropped. The workspace
 * action said nothing at all — four bare `return`s, no toast on any branch —
 * so a confirmed "Batch validate text…" dialog that found nothing eligible was
 * a dead click with no events, no error and no telemetry.
 *
 * So the assertions here are about SILENCE, not just arithmetic: every branch
 * must produce a message, every skipped cell must land in exactly one reported
 * bucket, and the telemetry must fire on the outcomes that validate nothing —
 * because "no events" was the only evidence the original repro could offer,
 * and it cannot tell a dead click apart from an unclicked button.
 */
import { describe, expect, it } from "vitest"
import {
  BATCH_VALIDATE_SKIP_REASONS,
  batchValidateSkipClauses,
  batchValidateSkipReason,
  batchValidateToast,
  batchValidateTelemetry,
  summarizeBatchValidate,
  type BatchValidateCandidate,
} from "./batch-validate-summary"
import type { MemberScope } from "@/lib/sync/member-scopes"

const ME = "tester"

function cell(over: Partial<BatchValidateCandidate> = {}): BatchValidateCandidate {
  return {
    id: "cell-1",
    fileId: "file-1",
    translated: "bonjour",
    targetEventId: "evt-1",
    aiDrafted: false,
    activeValidators: [],
    ...over,
  }
}

const base = { username: ME, myScopes: [] as MemberScope[], activeLane: "" }

/** A `t` that renders `key(vars)` so assertions can name the key, not the copy. */
const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${JSON.stringify(vars)})` : key) as never
const joinList = (items: readonly string[]) => items.join(" + ")

describe("batchValidateSkipReason — one bucket per cell", () => {
  it("returns null for a plain human-written, committed, in-scope cell", () => {
    expect(batchValidateSkipReason(cell(), ME, [], "")).toBeNull()
  })

  it("names an empty target as needing a translation", () => {
    expect(batchValidateSkipReason(cell({ translated: "   " }), ME, [], "")).toBe("needsTranslation")
  })

  it("names a cell this user already signed off", () => {
    expect(batchValidateSkipReason(cell({ activeValidators: [ME] }), ME, [], "")).toBe("alreadyMine")
  })

  it("does NOT skip a cell someone else signed off", () => {
    expect(batchValidateSkipReason(cell({ activeValidators: ["other"] }), ME, [], "")).toBeNull()
  })

  it("names an untouched AI draft — the rule bulk validation deliberately keeps", () => {
    expect(batchValidateSkipReason(cell({ aiDrafted: true }), ME, [], "")).toBe("aiDraft")
  })

  it("names a translation with no committed event as not committed", () => {
    expect(batchValidateSkipReason(cell({ targetEventId: null }), ME, [], "")).toBe("notCommitted")
  })

  it("names a cell outside this member's file scope", () => {
    const scopes: MemberScope[] = [{ kind: "file", value: "other-file" }]
    expect(batchValidateSkipReason(cell(), ME, scopes, "")).toBe("outOfScope")
  })

  it("names a cell outside this member's lane scope", () => {
    const scopes: MemberScope[] = [{ kind: "lane", value: "fr" }]
    expect(batchValidateSkipReason(cell(), ME, scopes, "es")).toBe("outOfScope")
  })
})

describe("summarizeBatchValidate — the accounting always balances", () => {
  it("loses no cell: eligible + every skip bucket equals the candidate count", () => {
    const candidates = [
      cell({ id: "a" }),
      cell({ id: "b", translated: "" }),
      cell({ id: "c", aiDrafted: true }),
      cell({ id: "d", activeValidators: [ME] }),
      cell({ id: "e", targetEventId: null }),
      cell({ id: "f" }),
    ]
    const summary = summarizeBatchValidate(candidates, base)
    const bucketed = BATCH_VALIDATE_SKIP_REASONS.reduce((n, r) => n + summary.skips[r], 0)
    expect(summary.validatable.map((c) => c.id)).toEqual(["a", "f"])
    expect(bucketed).toBe(summary.skippedTotal)
    expect(summary.validatable.length + bucketed).toBe(candidates.length)
    expect(summary.outcome).toBe("partial")
  })

  it("reports a clean run with no skips as `validated`", () => {
    const summary = summarizeBatchValidate([cell({ id: "a" }), cell({ id: "b" })], base)
    expect(summary.outcome).toBe("validated")
    expect(summary.skippedTotal).toBe(0)
  })

  it("reports `nothing-eligible` — the dead-click case — when candidates exist but none qualifies", () => {
    const summary = summarizeBatchValidate(
      [cell({ id: "a", aiDrafted: true }), cell({ id: "b", aiDrafted: true })],
      base,
    )
    expect(summary.outcome).toBe("nothing-eligible")
    expect(summary.validatable).toEqual([])
    expect(summary.skips.aiDraft).toBe(2)
  })

  it("distinguishes an empty selection from an ineligible one", () => {
    expect(summarizeBatchValidate([], base).outcome).toBe("no-candidates")
  })

  it("reports a role below the validation floor without inspecting cells", () => {
    const summary = summarizeBatchValidate([cell()], { ...base, canValidate: false })
    expect(summary.outcome).toBe("no-permission")
    expect(summary.validatable).toEqual([])
  })

  it("reports a missing project/file target", () => {
    expect(summarizeBatchValidate([cell()], { ...base, hasTarget: false }).outcome).toBe("no-target")
  })
})

describe("summarizeBatchValidate — AQU-586 per-run cap", () => {
  it("holds the overflow back without calling it a skip", () => {
    const candidates = [cell({ id: "a" }), cell({ id: "b" }), cell({ id: "c" })]
    const summary = summarizeBatchValidate(candidates, { ...base, cap: 2 })
    expect(summary.validatable.map((c) => c.id)).toEqual(["a", "b"])
    expect(summary.cappedOut).toBe(1)
    // Capped cells stay eligible — running again picks them up — so they are
    // never counted as rejected work.
    expect(summary.skippedTotal).toBe(0)
    expect(summary.outcome).toBe("partial")
  })

  it("treats a cap of 0 or undefined as no cap", () => {
    const candidates = [cell({ id: "a" }), cell({ id: "b" })]
    expect(summarizeBatchValidate(candidates, { ...base, cap: 0 }).validatable).toHaveLength(2)
    expect(summarizeBatchValidate(candidates, { ...base, cap: null }).validatable).toHaveLength(2)
  })

  it("does not call a fully-capped-out run eligible", () => {
    // Every eligible cell deferred is still something to SAY, not a silent exit.
    const summary = summarizeBatchValidate([cell({ id: "a" })], { ...base, cap: 0.5 })
    expect(summary.validatable).toEqual([])
    expect(summary.outcome).toBe("nothing-eligible")
  })
})

describe("batchValidateToast — no branch is silent", () => {
  it("produces a message for EVERY outcome, including the no-op ones", () => {
    const cases = [
      summarizeBatchValidate([], base),
      summarizeBatchValidate([cell()], { ...base, canValidate: false }),
      summarizeBatchValidate([cell()], { ...base, hasTarget: false }),
      summarizeBatchValidate([cell({ aiDrafted: true })], base),
      summarizeBatchValidate([cell()], base),
      summarizeBatchValidate([cell({ id: "a" }), cell({ id: "b", translated: "" })], base),
    ]
    for (const summary of cases) {
      const message = batchValidateToast(summary, t, joinList)
      expect(message.title, summary.outcome).toBeTruthy()
    }
  })

  it("explains a nothing-eligible run instead of just saying zero", () => {
    const summary = summarizeBatchValidate(
      [cell({ id: "a", aiDrafted: true }), cell({ id: "b", translated: "" })],
      base,
    )
    const message = batchValidateToast(summary, t, joinList)
    expect(message.type).toBe("info")
    expect(message.title).toContain("nothingEligibleTitle")
    expect(message.description).toContain("skip.aiDraft")
    expect(message.description).toContain("skip.needsTranslation")
  })

  it("names every skip class in a partial run, not only the already-validated one", () => {
    const summary = summarizeBatchValidate(
      [
        cell({ id: "a" }),
        cell({ id: "b", activeValidators: [ME] }),
        cell({ id: "c", aiDrafted: true }),
        cell({ id: "d", translated: "" }),
      ],
      base,
    )
    const message = batchValidateToast(summary, t, joinList)
    expect(message.type).toBe("success")
    // The count in the summary line is the whole difference, so it can never
    // disagree with the number of cells the user watched not change.
    expect(message.description).toContain('"count":3')
    for (const fragment of ["skip.alreadyMine", "skip.aiDraft", "skip.needsTranslation"]) {
      expect(message.description).toContain(fragment)
    }
  })

  it("falls back to a plain explanation when no reason bucket applies", () => {
    // `no-candidates` has nothing to explain; it still speaks.
    const message = batchValidateToast(summarizeBatchValidate([], base), t, joinList)
    expect(message.title).toContain("noCandidates")
  })

  it("marks a failed run as an error that admits it may be partial", () => {
    const summary = { ...summarizeBatchValidate([cell()], base), outcome: "failed" as const }
    const message = batchValidateToast(summary, t, joinList)
    expect(message.type).toBe("error")
    expect(message.description).toContain("failedBody")
  })

  it("mentions the cap as deferred work rather than a rejection", () => {
    const summary = summarizeBatchValidate([cell({ id: "a" }), cell({ id: "b" })], { ...base, cap: 1 })
    const clauses = batchValidateSkipClauses(summary, t)
    expect(clauses.join(" ")).toContain("skip.cappedOut")
  })
})

describe("batchValidateTelemetry — the surface can no longer be invisible", () => {
  it("carries the cell count and outcome on a run that validated nothing", () => {
    const summary = summarizeBatchValidate([cell({ aiDrafted: true })], base)
    expect(batchValidateTelemetry(summary, "workspace-action")).toMatchObject({
      source: "workspace-action",
      outcome: "nothing-eligible",
      validated_count: 0,
      skipped_count: 1,
      skipped_ai_draft: 1,
    })
  })

  it("distinguishes the two surfaces that share the 'Validate text' label", () => {
    const summary = summarizeBatchValidate([cell()], base)
    expect(batchValidateTelemetry(summary, "selection").source).toBe("selection")
    expect(batchValidateTelemetry(summary, "workspace-action").source).toBe("workspace-action")
  })
})

// The org setting (Sam, 2026-10-01): with it on, the drafts that used to land
// in the "aiDraft" bucket are validated instead, and the bucket stays empty.
describe("summarizeBatchValidate — when the org allows AI drafts in bulk", () => {
  it("validates untouched AI drafts instead of skipping them", () => {
    const cells = [cell({ id: "a", aiDrafted: true }), cell({ id: "b", aiDrafted: true }), cell({ id: "c", translated: "" })]
    const off = summarizeBatchValidate(cells, base)
    expect(off.validatable).toHaveLength(0)
    expect(off.skips.aiDraft).toBe(2)
    const on = summarizeBatchValidate(cells, { ...base, allowAiDrafts: true })
    expect(on.validatable.map((c) => c.id)).toEqual(["a", "b"])
    expect(on.skips.aiDraft).toBe(0)
    expect(on.skips.needsTranslation).toBe(1)
    expect(on.outcome).toBe("partial")
  })

  it("still names a draft this user already signed off as theirs", () => {
    expect(batchValidateSkipReason(cell({ aiDrafted: true, activeValidators: [ME] }), ME, [], "", { allowAiDrafts: true }))
      .toBe("alreadyMine")
  })
})
