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
  BATCH_VALIDATE_CHUNK_FALLBACK,
  BATCH_VALIDATE_SKIP_REASONS,
  batchValidateChunkSize,
  batchValidateConfirmDescription,
  batchValidateSkipClauses,
  batchValidateSkipReason,
  batchValidateToast,
  batchValidateTelemetry,
  chunksOf,
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
    const cells = [
      cell({ id: "a", lastEditor: "other", aiDrafted: true }),
      cell({ id: "b", lastEditor: "other", aiDrafted: true }),
    ]
    const summary = summarizeBatchValidate(cells, base)
    expect(summary.validatable.map((c) => c.id)).toEqual(["a", "b"])
    expect(summary.skippedTotal).toBe(0)
    expect(summary.outcome).toBe("validated")
  })

  // The reported repro: 5 of another user's cells + 2 the caller edited. All 7
  // used to be reduced to the caller's 2.
  it("validates another user's cells alongside the caller's own", () => {
    const cells = [
      ...[1, 2, 3, 4, 5].map((n) => cell({ id: `other-${n}`, lastEditor: "other", aiDrafted: true })),
      ...[1, 2].map((n) => cell({ id: `mine-${n}`, lastEditor: ME })),
    ]
    const summary = summarizeBatchValidate(cells, base)
    expect(summary.validatable).toHaveLength(7)
    expect(summary.outcome).toBe("validated")
  })

  it("does not bucket a machine draft unless the file-wide run opts out", () => {
    expect(summarizeBatchValidate([cell({ aiDrafted: true })], base).skips.aiDraft).toBe(0)
    const optedOut = summarizeBatchValidate(
      [cell({ id: "a", aiDrafted: true })],
      { ...base, includeUntouchedAiDrafts: false },
    )
    expect(optedOut.validatable).toEqual([])
    expect(optedOut.skips.aiDraft).toBe(1)
    expect(optedOut.outcome).toBe("nothing-eligible")
  })

  it("keeps an AI draft someone else already checked when untouched drafts are left out", () => {
    const summary = summarizeBatchValidate(
      [cell({ id: "second", aiDrafted: true, activeValidators: ["joy"] })],
      { ...base, includeUntouchedAiDrafts: false },
    )
    expect(summary.validatable.map((c) => c.id)).toEqual(["second"])
    expect(summary.skips.aiDraft).toBe(0)
  })

  it("names the AI drafts a file-wide run left for individual review", () => {
    const summary = summarizeBatchValidate(
      [cell({ aiDrafted: true }), cell({ id: "human" })],
      { ...base, includeUntouchedAiDrafts: false },
    )
    expect(summary.validatable.map((c) => c.id)).toEqual(["human"])
    const toast = batchValidateToast(summary, t, joinList)
    expect(toast.description).toContain("editor.batchValidate.skip.aiDraft")
  })

  // Restoring the old exclusion must fail a test, not slip through green.
  it("buckets a machine-drafted line nowhere — it is simply validated", () => {
    const summary = summarizeBatchValidate([cell({ id: "a", aiDrafted: true })], base)
    expect(summary.validatable.map((c) => c.id)).toEqual(["a"])
    expect(summary.skippedTotal).toBe(0)
    expect(batchValidateSkipReason(cell({ aiDrafted: true }), ME, [], "")).toBeNull()
  })

  it("still names a cell this user already signed off as theirs", () => {
    expect(batchValidateSkipReason(cell({ activeValidators: [ME] }), ME, [], "")).toBe("alreadyMine")
  })

  it("describes the run without claiming the text is human-authored", () => {
    const body = batchValidateConfirmDescription(
      summarizeBatchValidate([cell({ aiDrafted: true })], base), t, joinList,
    )
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

  it("keeps the books balanced with every skip reason in play", () => {
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
      needsTranslation: 1, aiDraft: 0, flagged: 0, alreadyMine: 1, ownEdit: 1, outOfScope: 1, notCommitted: 1, notChosen: 0,
    })
    const bucketed = BATCH_VALIDATE_SKIP_REASONS.reduce((n, r) => n + summary.skips[r], 0)
    expect(BATCH_VALIDATE_SKIP_REASONS).toHaveLength(8)
    expect(bucketed).toBe(summary.skippedTotal)
    expect(summary.validatable.map((c) => c.id)).toEqual(["ok"])
    expect(summary.validatable.length + bucketed).toBe(candidates.length)
  })

  it("reads its clause after already-mine and before out-of-scope", () => {
    expect(BATCH_VALIDATE_SKIP_REASONS).toEqual([
      "needsTranslation", "aiDraft", "flagged", "alreadyMine", "ownEdit", "outOfScope", "notCommitted", "notChosen",
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

  it("lets a listed reader with the role through", () => {
    const o = opts(project({
      validationNamedUsers: [ME],
      validationRoleFloor: "reviewer",
      syncRole: { level: ROLE.REVIEWER, name: "reviewer", source: "project" },
      completionSettings: { validationBatchSize: 5 },
    }))
    expect(o).toMatchObject({ canValidate: true, hasTarget: true })
  })

  // AQU-2507: the project's batch size used to come back as `cap`, which made
  // the file-wide summary — and therefore the dialog's promise and the run —
  // stop at 500 cells and say "535 left for the next run". It is the run's
  // CHUNK size now, read separately by the caller, so this builder must NOT
  // reintroduce a ceiling: a pretranslated book validates from one click.
  it("asks for no cap, so a file-wide run describes the whole file (AQU-2507)", () => {
    const o = opts(project({
      syncRole: { level: ROLE.REVIEWER, name: "reviewer", source: "project" },
      completionSettings: { validationBatchSize: 500 },
    }))
    expect(o.cap).toBeUndefined()
    const candidates = Array.from({ length: 879 }, (_, i) => cell({ id: `c${i}` }))
    const summary = summarizeBatchValidate(candidates, o)
    expect(summary.validatable).toHaveLength(879)
    expect(summary.cappedOut).toBe(0)
    expect(summary.outcome).toBe("validated")
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

// ---------------------------------------------------------------------------
// AQU-2507 — one action validates the whole file
// ---------------------------------------------------------------------------

/**
 * The reported defect, in Anita Beniston's words via Joel (2026-11-10): she
 * imported five pretranslated books (Mark, Luke, John, Titus, James) whose text
 * was already approved outside Aquilla, and "Validate all" on John (879 cells)
 * came back "Validated 363 cells. Skipped 616 — 81 still need a translation,
 * 535 left for the next run." Accepting five books meant clicking until the
 * toast stopped saying that.
 *
 * So these guards are about the WHOLE file: the run's chunking must partition
 * the eligible cells, never truncate them, and the dialog must promise
 * completion rather than another click.
 */
describe("chunksOf — the chunk partitions the work, it does not truncate it", () => {
  it("covers every cell exactly once, in order", () => {
    const cells = Array.from({ length: 879 }, (_, i) => `c${i}`)
    const chunks = chunksOf(cells, 500)
    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.length)).toEqual([500, 379])
    expect(chunks.flat()).toEqual(cells)
  })

  it("covers a 2,870-cell file from one action", () => {
    const cells = Array.from({ length: 2870 }, (_, i) => i)
    const chunks = chunksOf(cells, 500)
    expect(chunks.flat()).toHaveLength(2870)
    expect(new Set(chunks.flat()).size).toBe(2870)
  })

  it("yields no chunks for no work, so a caller's loop body never runs on nothing", () => {
    expect(chunksOf([], 500)).toEqual([])
  })

  it("falls back to a usable chunk rather than looping forever on a bad size", () => {
    expect(batchValidateChunkSize(0)).toBe(BATCH_VALIDATE_CHUNK_FALLBACK)
    expect(batchValidateChunkSize(null)).toBe(BATCH_VALIDATE_CHUNK_FALLBACK)
    expect(batchValidateChunkSize(undefined)).toBe(BATCH_VALIDATE_CHUNK_FALLBACK)
    expect(batchValidateChunkSize(-5)).toBe(BATCH_VALIDATE_CHUNK_FALLBACK)
    expect(batchValidateChunkSize(Number.NaN)).toBe(BATCH_VALIDATE_CHUNK_FALLBACK)
    expect(batchValidateChunkSize(0.5)).toBe(1)
    expect(batchValidateChunkSize(20)).toBe(20)
    expect(chunksOf([1, 2, 3], 0)).toEqual([[1, 2, 3]])
  })
})

describe("batchValidateConfirmDescription — the dialog promises completion (AQU-2507)", () => {
  it("tells a multi-batch run it finishes the file, and never to run again", () => {
    const candidates = Array.from({ length: 879 }, (_, i) => cell({ id: `c${i}` }))
    const body = batchValidateConfirmDescription(
      summarizeBatchValidate(candidates, base), t, joinList, 500,
    )
    expect(body).toContain("willValidate")
    expect(body).toContain('"count":879')
    expect(body).toContain("runsToCompletion")
    expect(body).not.toContain("capNote")
  })

  it("says nothing about batches when one batch covers the file", () => {
    const body = batchValidateConfirmDescription(
      summarizeBatchValidate([cell({ id: "a" })], base), t, joinList, 500,
    )
    expect(body).not.toContain("runsToCompletion")
  })

  it("keeps the batch note off a run that will validate nothing", () => {
    const body = batchValidateConfirmDescription(
      summarizeBatchValidate([cell({ id: "a", translated: "" })], base), t, joinList, 1,
    )
    expect(body).toContain("nothingToValidate")
    expect(body).not.toContain("runsToCompletion")
  })
})

describe("summarizeBatchValidate — open check flags are a choice (AQU-2507)", () => {
  const flagged = (...ids: string[]) => ({
    ...base,
    hasOpenFlags: (cellId: string) => ids.includes(cellId),
  })

  it("leaves flagged cells out by default and reports them in their own bucket", () => {
    const summary = summarizeBatchValidate(
      [cell({ id: "clean" }), cell({ id: "dirty" })],
      flagged("dirty"),
    )
    expect(summary.validatable.map((c) => c.id)).toEqual(["clean"])
    expect(summary.skips.flagged).toBe(1)
    expect(summary.outcome).toBe("partial")
    expect(batchValidateSkipClauses(summary, t).join(" ")).toContain("skip.flagged")
  })

  it("validates them when the reader opts in — their check overrules the flag", () => {
    const summary = summarizeBatchValidate(
      [cell({ id: "clean" }), cell({ id: "dirty" })],
      { ...flagged("dirty"), includeFlaggedCells: true },
    )
    expect(summary.validatable.map((c) => c.id)).toEqual(["clean", "dirty"])
    expect(summary.skips.flagged).toBe(0)
    expect(summary.outcome).toBe("validated")
  })

  it("asks nothing of a surface that does not supply the predicate", () => {
    const summary = summarizeBatchValidate([cell({ id: "a" })], base)
    expect(summary.validatable.map((c) => c.id)).toEqual(["a"])
    expect(summary.skips.flagged).toBe(0)
  })

  it("never validates an empty cell, flagged or not, and still counts it", () => {
    const summary = summarizeBatchValidate(
      [cell({ id: "empty", translated: "  " })],
      flagged("empty"),
    )
    expect(summary.validatable).toEqual([])
    expect(summary.skips.needsTranslation).toBe(1)
    expect(summary.skips.flagged).toBe(0)
  })

  it("reports a flagged untouched AI draft under the AI-draft box, not twice", () => {
    const summary = summarizeBatchValidate(
      [cell({ id: "ai", aiDrafted: true })],
      { ...flagged("ai"), includeUntouchedAiDrafts: false },
    )
    expect(summary.skips.aiDraft).toBe(1)
    expect(summary.skips.flagged).toBe(0)
    const bucketed = BATCH_VALIDATE_SKIP_REASONS.reduce((n, r) => n + summary.skips[r], 0)
    expect(bucketed).toBe(summary.skippedTotal)
  })
})

describe("batchValidateTelemetry — the chunked run is on the record (AQU-2507)", () => {
  it("carries the eligible total, the chunk count and the flagged choice", () => {
    const candidates = Array.from({ length: 879 }, (_, i) => cell({ id: `c${i}` }))
    const summary = summarizeBatchValidate(candidates, base)
    const props = batchValidateTelemetry(summary, "workspace-action", {
      chunks: chunksOf(summary.validatable, 500).length,
      chunkSize: 500,
      includedFlagged: true,
    })
    expect(props).toMatchObject({
      outcome: "validated",
      validated_count: 879,
      eligible_total: 879,
      chunk_count: 2,
      chunk_size: 500,
      included_flagged: 1,
      skipped_flagged: 0,
    })
  })

  it("omits the run properties on a surface that does not chunk", () => {
    const props = batchValidateTelemetry(summarizeBatchValidate([cell()], base), "selection")
    expect(props.chunk_count).toBeUndefined()
    expect(props.included_flagged).toBeUndefined()
    expect(props.skipped_flagged).toBe(0)
  })
})

/**
 * AQU-2507 acceptance: "interruption resumable (re-run continues, idempotent)".
 *
 * The run flushes each chunk before starting the next, so a closed tab or a
 * lost connection leaves the chunks it finished durably validated. What makes
 * re-running safe is that eligibility is recomputed from live cell state: a
 * cell this reader has already signed off comes back as `alreadyMine` and is
 * never voted on twice, and the next run picks up exactly the remainder.
 */
describe("summarizeBatchValidate — re-running resumes rather than restarts (AQU-2507)", () => {
  it("skips what the interrupted run already signed off and validates only the rest", () => {
    const file = Array.from({ length: 879 }, (_, i) => cell({ id: `c${i}` }))
    const first = summarizeBatchValidate(file, base)
    expect(first.validatable).toHaveLength(879)

    // The tab closed after the first chunk of 500 landed.
    const done = new Set(chunksOf(first.validatable, 500)[0].map((c) => c.id))
    const afterInterruption = file.map((c) =>
      done.has(c.id) ? { ...c, activeValidators: [ME] } : c)

    const second = summarizeBatchValidate(afterInterruption, base)
    expect(second.validatable).toHaveLength(379)
    expect(second.skips.alreadyMine).toBe(500)
    expect(second.validatable.some((c) => done.has(c.id))).toBe(false)

    // And a third run, once nothing is left, is a no-op that still says so.
    const allDone = file.map((c) => ({ ...c, activeValidators: [ME] }))
    const third = summarizeBatchValidate(allDone, base)
    expect(third.validatable).toEqual([])
    expect(third.outcome).toBe("nothing-eligible")
    expect(batchValidateToast(third, t, joinList).title).toContain("nothingEligibleTitle")
  })
})
