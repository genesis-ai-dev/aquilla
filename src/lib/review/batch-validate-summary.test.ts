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
  batchValidateConfirmDescription,
  batchValidateSkipClauses,
  batchValidateSkipReason,
  batchValidateToast,
  batchValidateTelemetry,
  noPermissionMessage,
  summarizeBatchValidate,
  workspaceBatchValidateOptions,
  type BatchValidateCandidate,
} from "./batch-validate-summary"
import type { MemberScope } from "@/lib/sync/member-scopes"
import { ROLE } from "@/lib/sync/role-policy"

const ME = "tester"

function cell(over: Partial<BatchValidateCandidate> = {}): BatchValidateCandidate {
  return {
    id: "cell-1",
    fileId: "file-1",
    translated: "bonjour",
    targetEventId: "evt-1",
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

  // AQU-1703: machine provenance is no longer a skip reason at all. The old
  // "aiDraft" bucket reported a refusal ("reviewed one at a time") for exactly
  // the cells a reviewer is there to sign off.
  it("does NOT skip a cell nobody has retyped", () => {
    expect(batchValidateSkipReason(cell(), ME, [], "")).toBeNull()
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
      [cell({ id: "a", activeValidators: [ME] }), cell({ id: "b", activeValidators: [ME] })],
      base,
    )
    expect(summary.outcome).toBe("nothing-eligible")
    expect(summary.validatable).toEqual([])
    expect(summary.skips.alreadyMine).toBe(2)
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
      summarizeBatchValidate([cell({ activeValidators: [ME] })], base),
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
      [cell({ id: "a", activeValidators: [ME] }), cell({ id: "b", translated: "" })],
      base,
    )
    const message = batchValidateToast(summary, t, joinList)
    expect(message.type).toBe("info")
    expect(message.title).toContain("nothingEligibleTitle")
    expect(message.description).toContain("skip.alreadyMine")
    expect(message.description).toContain("skip.needsTranslation")
  })

  it("names every skip class in a partial run, not only the already-validated one", () => {
    const summary = summarizeBatchValidate(
      [
        cell({ id: "a" }),
        cell({ id: "b", activeValidators: [ME] }),
        cell({ id: "c", targetEventId: null }),
        cell({ id: "d", translated: "" }),
      ],
      base,
    )
    const message = batchValidateToast(summary, t, joinList)
    expect(message.type).toBe("success")
    // The count in the summary line is the whole difference, so it can never
    // disagree with the number of cells the user watched not change.
    expect(message.description).toContain('"count":3')
    for (const fragment of ["skip.alreadyMine", "skip.notCommitted", "skip.needsTranslation"]) {
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
    const summary = summarizeBatchValidate([cell({ activeValidators: [ME] })], base)
    expect(batchValidateTelemetry(summary, "workspace-action")).toMatchObject({
      source: "workspace-action",
      outcome: "nothing-eligible",
      validated_count: 0,
      skipped_count: 1,
      skipped_already_mine: 1,
    })
  })

  it("distinguishes the two surfaces that share the 'Validate text' label", () => {
    const summary = summarizeBatchValidate([cell()], base)
    expect(batchValidateTelemetry(summary, "selection").source).toBe("selection")
    expect(batchValidateTelemetry(summary, "workspace-action").source).toBe("workspace-action")
  })
})

// AQU-1703 — the bounce of AQU-1503. The old rule excluded `cells.ai_drafted`
// from bulk validation, with an org switch to lift it. `ai_drafted` is cleared
// by a human target COMMIT, so eligibility tracked "has somebody retyped this"
// rather than "is there committed text to sign off": a reviewer multi-selecting
// a colleague's AI-assisted translations was told they were "reviewed one at a
// time", and in a mixed selection only the lines the reviewer had typed
// themselves were signed off. These are the guards for the corrected rule.
describe("summarizeBatchValidate — machine provenance is not an eligibility rule", () => {
  it("validates a selection in which the caller has edited nothing", () => {
    const cells = [cell({ id: "a", lastEditor: "other" }), cell({ id: "b", lastEditor: "other" })]
    const summary = summarizeBatchValidate(cells, base)
    expect(summary.validatable.map((c) => c.id)).toEqual(["a", "b"])
    expect(summary.skippedTotal).toBe(0)
    expect(summary.outcome).toBe("validated")
  })

  // The reported repro: 5 of another user's cells + 2 the caller edited. All 7
  // used to be reduced to the caller's 2.
  it("validates another user's cells alongside the caller's own", () => {
    const cells = [
      ...[1, 2, 3, 4, 5].map((n) => cell({ id: `other-${n}`, lastEditor: "other" })),
      ...[1, 2].map((n) => cell({ id: `mine-${n}`, lastEditor: ME })),
    ]
    const summary = summarizeBatchValidate(cells, base)
    expect(summary.validatable).toHaveLength(7)
    expect(summary.outcome).toBe("validated")
  })

  it("no skip bucket reports a refusal to review in bulk", () => {
    expect(BATCH_VALIDATE_SKIP_REASONS).not.toContain("aiDraft")
  })

  it("still names a cell this user already signed off as theirs", () => {
    expect(batchValidateSkipReason(cell({ activeValidators: [ME] }), ME, [], "")).toBe("alreadyMine")
  })

  it("describes the run without claiming the text is human-authored", () => {
    const body = batchValidateConfirmDescription(summarizeBatchValidate([cell()], base), t, joinList)
    expect(body).toContain("nav.workspaceActions.batchValidate.willValidate")
    expect(body).not.toContain("WithDrafts")
  })
})

// AQU-1571: with "Allow self-validation" off, the server refuses a vote on the
// caller's own latest change. Both bulk paths now leave those lines alone and
// say so, in their own bucket, instead of sending votes that come back as a
// red "failed" banner.
describe("summarizeBatchValidate — the caller's own latest change", () => {
  const off = { ...base, allowSelfValidation: false }

  it("buckets the caller's own latest change as ownEdit, and only when the setting is off", () => {
    expect(batchValidateSkipReason(cell({ lastEditor: ME }), ME, [], "", { allowSelfValidation: false })).toBe("ownEdit")
    expect(batchValidateSkipReason(cell({ lastEditor: ME }), ME, [], "", { allowSelfValidation: true })).toBeNull()
    expect(batchValidateSkipReason(cell({ lastEditor: ME }), ME, [], "")).toBeNull()
    expect(batchValidateSkipReason(cell({ lastEditor: "other" }), ME, [], "", { allowSelfValidation: false })).toBeNull()
  })

  it("never treats an unknown editor as the caller", () => {
    expect(batchValidateSkipReason(cell({ lastEditor: null }), ME, [], "", { allowSelfValidation: false })).toBeNull()
    expect(batchValidateSkipReason(cell(), ME, [], "", { allowSelfValidation: false })).toBeNull()
  })

  // needsTranslation → alreadyMine → notCommitted → ownEdit → outOfScope.
  it("sits after already-mine and not-committed, and before scope", () => {
    const self = { allowSelfValidation: false }
    expect(batchValidateSkipReason(cell({ lastEditor: ME, activeValidators: [ME] }), ME, [], "", self)).toBe("alreadyMine")
    expect(batchValidateSkipReason(cell({ lastEditor: ME, targetEventId: null }), ME, [], "", self)).toBe("notCommitted")
    const scopes: MemberScope[] = [{ kind: "file", value: "other-file" }]
    expect(batchValidateSkipReason(cell({ lastEditor: ME }), ME, scopes, "", self)).toBe("ownEdit")
  })

  it("keeps the books balanced with all five reasons in play", () => {
    const scopes: MemberScope[] = [{ kind: "file", value: "file-1" }]
    const candidates = [
      cell({ id: "ok" }),
      cell({ id: "empty", translated: "" }),
      cell({ id: "mine", activeValidators: [ME] }),
      cell({ id: "own", lastEditor: ME }),
      cell({ id: "away", fileId: "file-2" }),
      cell({ id: "unsaved", targetEventId: null }),
    ]
    const summary = summarizeBatchValidate(candidates, { ...off, myScopes: scopes })
    expect(summary.skips).toEqual({
      needsTranslation: 1, alreadyMine: 1, ownEdit: 1, outOfScope: 1, notCommitted: 1,
    })
    const bucketed = BATCH_VALIDATE_SKIP_REASONS.reduce((n, r) => n + summary.skips[r], 0)
    expect(BATCH_VALIDATE_SKIP_REASONS).toHaveLength(5)
    expect(bucketed).toBe(summary.skippedTotal)
    expect(summary.validatable.map((c) => c.id)).toEqual(["ok"])
    expect(summary.validatable.length + bucketed).toBe(candidates.length)
  })

  it("reads its clause after already-mine and before out-of-scope", () => {
    expect(BATCH_VALIDATE_SKIP_REASONS).toEqual([
      "needsTranslation", "alreadyMine", "ownEdit", "outOfScope", "notCommitted",
    ])
    const scopes: MemberScope[] = [{ kind: "file", value: "file-1" }]
    const summary = summarizeBatchValidate(
      [cell({ id: "a" }), cell({ id: "b", activeValidators: [ME] }), cell({ id: "c", lastEditor: ME }), cell({ id: "d", fileId: "file-2" })],
      { ...off, myScopes: scopes },
    )
    const clauses = batchValidateSkipClauses(summary, t)
    expect(clauses.map((c) => c.replace(/\(.*$/, ""))).toEqual([
      "editor.batchValidate.skip.alreadyMine",
      "editor.batchValidate.skip.ownEdit",
      "editor.batchValidate.skip.outOfScope",
    ])
  })

  it("names the clause in the toast and in the confirmation", () => {
    const summary = summarizeBatchValidate([cell({ id: "a" }), cell({ id: "b", lastEditor: ME })], off)
    expect(summary.outcome).toBe("partial")
    expect(batchValidateToast(summary, t, joinList).description).toContain("skip.ownEdit")
    const confirm = batchValidateConfirmDescription(summary, t, joinList)
    expect(confirm).toContain("nav.workspaceActions.batchValidate.willValidate")
    expect(confirm).toContain('"count":1')
    expect(confirm).toContain("skip.ownEdit")
  })

  it("says why nothing will happen when every line is the caller's own", () => {
    const summary = summarizeBatchValidate([cell({ id: "a", lastEditor: ME }), cell({ id: "b", lastEditor: ME })], off)
    expect(summary.outcome).toBe("nothing-eligible")
    expect(batchValidateToast(summary, t, joinList).description).toContain("skip.ownEdit")
    expect(batchValidateConfirmDescription(summary, t, joinList)).toContain("skip.ownEdit")
  })

  it("reports the bucket to telemetry", () => {
    const summary = summarizeBatchValidate([cell({ id: "a", lastEditor: ME }), cell({ id: "b" })], off)
    expect(batchValidateTelemetry(summary, "selection")).toMatchObject({
      skipped_count: 1,
      skipped_own_edit: 1,
      validated_count: 1,
    })
    expect(batchValidateTelemetry(summarizeBatchValidate([cell()], base), "selection").skipped_own_edit).toBe(0)
  })
})

/**
 * AQU-1571: "Batch validate text…" builds its options from the open project.
 * Each project rule the server enforces on a vote has to reach the summary,
 * or the run queues votes the server refuses and ends in a red "N failed".
 */
describe("workspaceBatchValidateOptions — the project's rules reach the run", () => {
  const project = (over: Record<string, unknown> = {}) => ({
    id: "p1",
    syncRole: { level: ROLE.CONTRIBUTOR, name: "contributor", source: "project" },
    ...over,
  }) as never
  const opts = (p: unknown, activeFileId: string | null = "file-1") =>
    workspaceBatchValidateOptions({
      project: p as never,
      activeFileId,
      username: ME,
      myScopes: [],
      activeLane: "",
    })

  it("passes 'Allow self-validation' through, so the reader's own lines are skipped", () => {
    const o = opts(project({ allowSelfValidation: false }))
    expect(o.allowSelfValidation).toBe(false)
    const summary = summarizeBatchValidate([cell({ lastEditor: ME })], o)
    expect(summary.validatable).toHaveLength(0)
    expect(summary.skips.ownEdit).toBe(1)
  })

  it("shuts out a reader below the project's minimum role, as a role refusal", () => {
    const o = opts(project({ validationRoleFloor: "project_lead" }))
    expect(o).toMatchObject({ canValidate: false, noPermissionReason: "role" })
    expect(summarizeBatchValidate([cell()], o).outcome).toBe("no-permission")
  })

  it("shuts out a reader off the named-validator list, without blaming their role", () => {
    const o = opts(project({ validationNamedUsers: ["someone-else"] }))
    expect(o).toMatchObject({ canValidate: false, noPermissionReason: "allowlist" })
    const summary = summarizeBatchValidate([cell()], o)
    expect(summary).toMatchObject({ outcome: "no-permission", noPermissionReason: "allowlist" })
    expect(batchValidateToast(summary, t, joinList).title).toBe("editor.batchValidate.notNamedValidator")
    expect(batchValidateConfirmDescription(summary, t, joinList)).toBe("editor.batchValidate.notNamedValidator")
  })

  it("calls a role that cannot validate at all a role refusal, even with a list set", () => {
    const o = opts(project({
      syncRole: { level: ROLE.COMMENTER, name: "commenter", source: "project" },
      validationNamedUsers: ["someone-else"],
    }))
    expect(o).toMatchObject({ canValidate: false, noPermissionReason: "role" })
  })

  it("lets a listed reader with the role through, with the project's cap", () => {
    const o = opts(project({
      validationNamedUsers: [ME],
      validationRoleFloor: "reviewer",
      syncRole: { level: ROLE.REVIEWER, name: "reviewer", source: "project" },
      completionSettings: { validationBatchSize: 5 },
    }))
    expect(o).toMatchObject({ canValidate: true, cap: 5, hasTarget: true })
  })

  it("has no target with no file open", () => {
    expect(opts(project(), null).hasTarget).toBe(false)
    expect(opts(null).hasTarget).toBe(false)
  })
})

describe("noPermissionMessage", () => {
  it("names the role only when the role is the reason", () => {
    expect(noPermissionMessage({ noPermissionReason: "role" }, t)).toBe("editor.batchValidate.noPermission")
    expect(noPermissionMessage({}, t)).toBe("editor.batchValidate.noPermission")
    expect(noPermissionMessage({ noPermissionReason: "allowlist" }, t)).toBe("editor.batchValidate.notNamedValidator")
  })
})
