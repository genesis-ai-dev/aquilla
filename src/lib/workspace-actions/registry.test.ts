import { describe, it, expect, vi } from "vitest"
import { getDefaultAction, getVisibleActions, workspaceActions, completionBatchSizeFor, MAX_BATCH_COMPLETIONS } from "./registry"
import type { WorkspaceAction, WorkspaceActionContext } from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { en } from "@/lib/i18n/messages/en"
import { translate } from "@/lib/i18n/translate"
import { formatList } from "@/lib/i18n/format"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { BatchValidateCandidate } from "@/lib/review/batch-validate-summary"
import { summarizeBatchValidate } from "@/lib/review/batch-validate-summary"
import { resetChangeVoiceQualityCacheForTests } from "@/lib/store/change-voice-quality"

// English-only `t`, standing in for the real I18nProvider hook — description()
// is resolved outside React (registry.ts has no component tree), so tests
// call it the same way ProjectWorkspace does: inject a `t`, don't hardcode
// English strings here.
const t: TFunction = (key, vars) => translate(undefined, key, vars)

// `useFormat().list` outside React (AQU-1507) — the locale-aware join a
// confirmation body that enumerates several clauses needs.
const joinList = (items: readonly string[]) => formatList(items)

// `en` values are `string | PluralMessage`; every labelKey used below resolves
// to a plain string, so this narrows without a plural-form branch.
function englishOf(key: WorkspaceAction["labelKey"]): string {
  const v = en[key]
  return typeof v === "string" ? v : ""
}

const project: ProjectRecord = {
  id: "p1", name: "t", sourceLanguage: "en", targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [{ id: "f1", name: "a", type: "md", createdAt: "2026-01-01T00:00:00Z", cellCount: 10 }],
  members: [],
}

function ctx(overrides: Partial<WorkspaceActionContext> = {}): WorkspaceActionContext {
  return {
    project,
    activeFileId: null,
    fileProgress: new Map(),
    ...overrides,
  }
}

// ── AQU-1507 fixtures: candidates for the shared batch-validate summary ─────
const ME = "me"

function cell(i: number, over: Partial<BatchValidateCandidate> = {}): BatchValidateCandidate {
  return { id: `c${i}`, fileId: "f1", translated: "bonjour", targetEventId: `e${i}`, ...over }
}
const make = (n: number, over: Partial<BatchValidateCandidate> = {}) =>
  Array.from({ length: n }, (_, i) => cell(i, over))

/** Human-written, committed, not yet signed off by me — the run validates these. */
const eligibleCells = (n: number) => make(n)
/** No target text at all: the footer counts them, the run cannot. */
const untranslatedCells = (n: number) => make(n, { translated: "", targetEventId: null })
/** Untouched AI drafts — individually reviewed on purpose (AQU-983). */
const aiDraftCells = (n: number) => make(n, { aiDrafted: true })
/** Already carrying my validation, so a second vote would be a wasted request. */
const alreadyMineCells = (n: number) => make(n, { activeValidators: [ME] })

function summarizeOptions(over: Partial<Parameters<typeof summarizeBatchValidate>[1]> = {}) {
  return { username: ME, myScopes: [], activeLane: "fr", ...over }
}

/**
 * The confirmation body the dialog would render, driven through the SAME
 * summary `runBatchValidate` consumes — which is the whole point of AQU-1507.
 */
function batchValidateDescription(
  candidates: BatchValidateCandidate[],
  over: { project?: ProjectRecord, cap?: number | null, canValidate?: boolean } = {},
): string {
  const action = workspaceActions.find((a) => a.id === "batch-validate")!
  const summary = summarizeBatchValidate(
    candidates,
    summarizeOptions({ cap: over.cap, canValidate: over.canValidate }),
  )
  return action.requiresConfirmation!.description(
    ctx({
      project: over.project ?? project,
      activeFileId: "f1",
      batchValidateSummary: () => summary,
    }),
    t,
    joinList,
  )
}

function mockActions(): WorkspaceAction[] {
  return [
    {
      id: "import-new", labelKey: "nav.workspaceActions.import",
      group: "primary",
      isAvailable: () => true,
      isDefault: (c) => c.activeFileId == null,
      run: vi.fn(),
    },
    {
      id: "run-completions", labelKey: "nav.workspaceActions.runCompletions.label",
      group: "primary",
      isAvailable: (c) => c.activeFileId != null,
      isDefault: (c) => {
        if (!c.activeFileId) return false
        const p = c.fileProgress.get(c.activeFileId)
        return !!p && p.translated < p.total
      },
      run: vi.fn(),
    },
    {
      id: "export", labelKey: "nav.workspaceActions.export",
      group: "primary",
      isAvailable: (c) => c.activeFileId != null,
      isDefault: (c) => {
        if (!c.activeFileId) return false
        const p = c.fileProgress.get(c.activeFileId)
        return !!p && p.total > 0 && p.validated === p.total
      },
      run: vi.fn(),
    },
  ]
}

describe("getDefaultAction", () => {
  it("returns import-new when no file open", () => {
    const def = getDefaultAction(mockActions(), ctx())
    expect(def.id).toBe("import-new")
  })
  it("returns run-completions when file open and partially translated", () => {
    const progress = new Map([["f1", { translated: 5, validated: 0, total: 10 }]])
    const def = getDefaultAction(mockActions(), ctx({ activeFileId: "f1", fileProgress: progress }))
    expect(def.id).toBe("run-completions")
  })
  it("returns export when file fully validated", () => {
    const progress = new Map([["f1", { translated: 10, validated: 10, total: 10 }]])
    const def = getDefaultAction(mockActions(), ctx({ activeFileId: "f1", fileProgress: progress }))
    expect(def.id).toBe("export")
  })
  it("falls back to first available when no isDefault matches", () => {
    const acts: WorkspaceAction[] = [
      { id: "a", labelKey: "common.save", group: "primary", isAvailable: () => false, run: vi.fn() },
      { id: "b", labelKey: "common.cancel", group: "primary", isAvailable: () => true, run: vi.fn() },
    ]
    const def = getDefaultAction(acts, ctx())
    expect(def.id).toBe("b")
  })
})

describe("export org-policy gate (AQU-253, revised)", () => {
  // AQU-253 revised: the export action stays VISIBLE regardless of the org
  // export floor. The gate moved into ExportDialog, which shows an explicit
  // "you don't have export permission" panel with a help link — a menu item
  // that silently disappears left users unable to learn why. The actual
  // export routes still enforce the floor server-side.
  const exportAction = workspaceActions.find((a) => a.id === "export")!

  it("stays visible when org policy forbids export (dialog shows the gate)", () => {
    expect(
      exportAction.isAvailable(ctx({ activeFileId: "f1", canExportByOrgPolicy: false })),
    ).toBe(true)
  })

  it("shows Export while policy is unknown (optimistic pre-fetch) or allowed", () => {
    expect(exportAction.isAvailable(ctx({ activeFileId: "f1" }))).toBe(true)
    expect(
      exportAction.isAvailable(ctx({ activeFileId: "f1", canExportByOrgPolicy: true })),
    ).toBe(true)
  })
})

describe("AQU-365: header actions hidden for below-floor roles", () => {
  const runCompletions = workspaceActions.find((a) => a.id === "run-completions")!
  const completeAll = workspaceActions.find((a) => a.id === "complete-all")!
  const batchValidate = workspaceActions.find((a) => a.id === "batch-validate")!

  function ctxWithRole(roleLevel: number | null, overrides: Partial<WorkspaceActionContext> = {}) {
    const projectWithRole: ProjectRecord = roleLevel === null
      ? project
      : { ...project, syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" } }
    return ctx({ project: projectWithRole, activeFileId: "f1", ...overrides })
  }

  it("hides Run AI completions / Complete all / Batch validate for a VIEWER (100)", () => {
    const c = ctxWithRole(ROLE.VIEWER)
    expect(runCompletions.isAvailable(c)).toBe(false)
    expect(completeAll.isAvailable(c)).toBe(false)
    expect(batchValidate.isAvailable(c)).toBe(false)
  })

  it("shows Batch validate (floor=reviewer) but hides translate actions (floor=contributor) for a REVIEWER (300)", () => {
    const c = ctxWithRole(ROLE.REVIEWER)
    expect(runCompletions.isAvailable(c)).toBe(false)
    expect(completeAll.isAvailable(c)).toBe(false)
    expect(batchValidate.isAvailable(c)).toBe(true)
  })

  it("shows all three for a CONTRIBUTOR (400)", () => {
    const progress = new Map([["f1", { translated: 5, validated: 0, total: 10 }]])
    const c = ctxWithRole(ROLE.CONTRIBUTOR, { fileProgress: progress })
    expect(runCompletions.isAvailable(c)).toBe(true)
    expect(completeAll.isAvailable(c)).toBe(true)
    expect(batchValidate.isAvailable(c)).toBe(true)
  })

  it("fails open (shows) for a local project with no syncRole", () => {
    const c = ctxWithRole(null)
    expect(runCompletions.isAvailable(c)).toBe(true)
    expect(batchValidate.isAvailable(c)).toBe(true)
  })
})

// AQU-481: the source-import action was the one primary entry with no role gate
// (`isAvailable: () => true`), so a VIEWER got the full Import type-picker with
// every importer clickable. Source import emits `file.create`, whose server
// floor is PROJECT_LEAD (500) — the server always refused, making this an
// affordance-honesty bug rather than a security hole. These guard the floor.
describe("AQU-481: source import gated at the file.create floor", () => {
  const importNew = workspaceActions.find((a) => a.id === "import-new")!

  function ctxWithRole(roleLevel: number | null, overrides: Partial<WorkspaceActionContext> = {}) {
    const projectWithRole: ProjectRecord = roleLevel === null
      ? project
      : { ...project, syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: "2026-01-01T00:00:00Z" } }
    return ctx({ project: projectWithRole, ...overrides })
  }

  it("refuses the import action for a VIEWER (100) — the reported repro", () => {
    expect(importNew.isAvailable(ctxWithRole(ROLE.VIEWER))).toBe(false)
    // …and with a file open, which is the "More actions" half of the repro.
    expect(importNew.isAvailable(ctxWithRole(ROLE.VIEWER, { activeFileId: "f1" }))).toBe(false)
  })

  it("refuses every role below PROJECT_LEAD (500)", () => {
    for (const level of [ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER, ROLE.CONTRIBUTOR]) {
      expect(importNew.isAvailable(ctxWithRole(level))).toBe(false)
    }
  })

  it("allows PROJECT_LEAD (500) and above", () => {
    for (const level of [ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER]) {
      expect(importNew.isAvailable(ctxWithRole(level))).toBe(true)
    }
  })

  it("fails open for a local project with no resolved syncRole", () => {
    // No server floor to enforce against — a local/unsynced project must keep
    // importing, same convention as canPerform and the AQU-365 actions above.
    expect(importNew.isAvailable(ctxWithRole(null))).toBe(true)
  })

  it("no longer offers import as the default action to a viewer with no file open", () => {
    // getDefaultAction only ever picks from getVisibleActions, so the gate above
    // is what keeps a viewer's primary CTA off a dialog the server refuses.
    const visible = getVisibleActions(workspaceActions, ctxWithRole(ROLE.VIEWER))
    expect(visible.map((a) => a.id)).not.toContain("import-new")
  })
})

describe("AQU-503: target import is discoverable by wording", () => {
  const importIntoFile = workspaceActions.find((a) => a.id === "import-into-file")!

  it("labels the file-scoped target importer with the word 'target'", () => {
    // A PM (Anna) searching for the "Target Import" option must recognize this
    // entry by its wording. The label must name the TARGET column so it is not
    // confused with the primary "Import" (source) action.
    expect(englishOf(importIntoFile.labelKey).toLowerCase()).toContain("target")
  })

  it("shows the target importer whenever a file is open, for any role (not permission-gated)", () => {
    // Investigation found this action has no role floor — the discoverability
    // gap was wording/location, not permissions. Guard that it stays visible
    // once a file is open, even for a viewer-level role.
    const projectWithRole: ProjectRecord = {
      ...project,
      syncRole: { level: ROLE.VIEWER, name: "viewer", source: "server", fetchedAt: "2026-01-01T00:00:00Z" },
    }
    expect(importIntoFile.isAvailable(ctx({ project: projectWithRole, activeFileId: "f1" }))).toBe(true)
    expect(importIntoFile.isAvailable(ctx({ activeFileId: null }))).toBe(false)
  })
})

// AQU-586: configurable batch sizes for Run AI completions / Batch validate.
describe("completionBatchSizeFor", () => {
  it("defaults to MAX_BATCH_COMPLETIONS when unset", () => {
    expect(completionBatchSizeFor(project)).toBe(MAX_BATCH_COMPLETIONS)
  })

  it("returns the project's configured completion batch size", () => {
    const p: ProjectRecord = { ...project, completionSettings: { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "", completionBatchSize: 25 } }
    expect(completionBatchSizeFor(p)).toBe(25)
  })

  it("clamps an over-large stored value to 50 and ignores non-positive values", () => {
    const big: ProjectRecord = { ...project, completionSettings: { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "", completionBatchSize: 9999 } }
    expect(completionBatchSizeFor(big)).toBe(50)
    const zero: ProjectRecord = { ...project, completionSettings: { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "", completionBatchSize: 0 } }
    expect(completionBatchSizeFor(zero)).toBe(MAX_BATCH_COMPLETIONS)
  })

  it("the run-completions confirmation reflects the configured batch size", () => {
    const p: ProjectRecord = { ...project, completionSettings: { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "", completionBatchSize: 3 } }
    const action = workspaceActions.find((a) => a.id === "run-completions")!
    const desc = action.requiresConfirmation!.description(
      ctx({ project: p, activeFileId: "f1", fileProgress: new Map([["f1", { translated: 0, validated: 0, total: 10 }]]) }),
      t,
      joinList,
    )
    expect(desc).toContain("next 3 untranslated cells")
    expect(desc).toContain("7 more after this")
  })

  it("the batch-validate confirmation notes the per-run cap when set", () => {
    const p: ProjectRecord = { ...project, completionSettings: { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "", validationBatchSize: 5 } }
    const desc = batchValidateDescription(
      eligibleCells(20),
      { project: p, cap: 5 },
    )
    // AQU-1507: the cap trims the promise as well as the run — 20 eligible
    // cells behind a cap of 5 must not be announced as 20.
    expect(desc).toContain("validates 5 eligible cells")
    expect(desc).toContain("At most 5 eligible cells are validated per run")
  })
})

// ── AQU-1507: the confirmation promises what the RUN will do ────────────────
//
// The body used to be built from file progress (`total - validated`), which
// counts untranslated cells, untouched AI drafts, cells this reader had already
// signed off and cells outside their assignment — none of which the run
// touches. On the reported file that read "83 cells are currently unvalidated"
// and then validated zero. These tests pin the count to the very summary the
// run consumes, so the two cannot drift apart again.
describe("batch-validate confirmation body", () => {
  it("promises only the cells the run will validate, and names the rest", () => {
    // The reported file: 4 untouched AI drafts and 79 untranslated cells, of
    // which none is eligible.
    const desc = batchValidateDescription([
      ...untranslatedCells(79),
      ...aiDraftCells(4),
    ])
    // 83 is still a true number about this file — it is what the run will NOT
    // touch. What must be gone is 83 offered as the thing about to happen.
    expect(desc).not.toContain("83 cells are currently unvalidated")
    expect(desc).not.toContain("validates 83")
    expect(desc).toContain("Nothing in this file can be batch-validated right now.")
    expect(desc).toContain("Skipped 83 cells")
    expect(desc).toContain("79 still need a translation")
    expect(desc).toContain("4 are untouched AI drafts")
  })

  it("counts a mixed file the way the run does, and accounts for every cell", () => {
    const candidates = [
      ...eligibleCells(6),
      ...untranslatedCells(3),
      ...aiDraftCells(2),
      ...alreadyMineCells(1),
    ]
    const summary = summarizeBatchValidate(candidates, summarizeOptions({}))
    // The invariant the dialog rests on: nothing is silently unaccounted for.
    expect(summary.validatable.length + summary.skippedTotal + summary.cappedOut)
      .toBe(candidates.length)

    const desc = batchValidateDescription(candidates)
    expect(desc).toContain("validates 6 eligible cells")
    expect(desc).toContain("Skipped 6 cells")
    expect(desc).toContain("3 still need a translation")
    expect(desc).toContain("2 are untouched AI drafts")
    expect(desc).toContain("1 you had already validated")
  })

  // The AQU-1507 regression guard proper: the dialog must not carry its own
  // notion of eligibility. Flip a cell so the SHARED predicate rejects it and
  // the promised number has to move with it.
  it("follows the shared eligibility predicate rather than a count of its own", () => {
    const cells = eligibleCells(4)
    expect(batchValidateDescription(cells)).toContain("validates 4 eligible cells")
    const withDraft: BatchValidateCandidate[] = [
      ...cells.slice(0, 3),
      { ...cells[3], aiDrafted: true },
    ]
    expect(batchValidateDescription(withDraft)).toContain("validates 3 eligible cells")
  })

  it("says there is nothing to look at on an empty file, without promising success", () => {
    const desc = batchValidateDescription([])
    expect(desc).toBe("There are no cells here to validate.")
  })

  it("explains a role below the validation floor instead of offering a count", () => {
    const desc = batchValidateDescription(eligibleCells(3), { canValidate: false })
    expect(desc).toBe("Your role cannot validate cells in this project.")
  })
})

describe("getVisibleActions", () => {
  it("filters out unavailable actions", () => {
    const acts: WorkspaceAction[] = [
      { id: "a", labelKey: "common.save", group: "primary", isAvailable: () => false, run: vi.fn() },
      { id: "b", labelKey: "common.cancel", group: "primary", isAvailable: () => true, run: vi.fn() },
    ]
    const visible = getVisibleActions(acts, ctx())
    expect(visible.map((a) => a.id)).toEqual(["b"])
  })
})

// ── The two audio actions are gated on audioCounts (2026-08-27) ─────────────
//
// `ctx()` never set `audioCounts`, so nothing pinned what these numbers do —
// which is how "Transcribe all recordings" came to be hidden outright on every
// file with an audio-cue sibling without a test noticing. On those files the
// count was computed over subtitle rows, which never carry a `selectedAudioId`,
// so it was permanently 0 and this predicate removed the item from the menu.
// A hidden item has no disabled state and no explanation: it simply is not
// there.
describe("the audio actions are gated on their counts", () => {
  const find = (id: string) => workspaceActions.find((a) => a.id === id)!

  it("offers each action only when there is work for it", () => {
    const transcribe = find("transcribe-all")
    const synth = find("synth-all")
    const counts = (untranscribed: number, unsynthesized: number) =>
      ctx({ activeFileId: "f1", audioCounts: { untranscribed, unsynthesized } })

    expect(transcribe.isAvailable!(counts(3, 0))).toBe(true)
    expect(transcribe.isAvailable!(counts(0, 3))).toBe(false)
    expect(synth.isAvailable!(counts(0, 3))).toBe(true)
    expect(synth.isAvailable!(counts(3, 0))).toBe(false)
  })

  it("offers neither with no file open, whatever the counts say", () => {
    const open = { audioCounts: { untranscribed: 5, unsynthesized: 5 } }
    expect(find("transcribe-all").isAvailable!(ctx({ ...open, activeFileId: null }))).toBe(false)
    expect(find("synth-all").isAvailable!(ctx({ ...open, activeFileId: null }))).toBe(false)
  })

  it("treats absent counts as no work rather than throwing", () => {
    const bare = ctx({ activeFileId: "f1" })
    expect(find("transcribe-all").isAvailable!(bare)).toBe(false)
    expect(find("synth-all").isAvailable!(bare)).toBe(false)
  })

  // The number in the confirmation dialog is the number the user consents to,
  // so it has to be the same one the gate used.
  it("confirms with the count it was gated on", () => {
    const c = ctx({ activeFileId: "f1", audioCounts: { untranscribed: 7, unsynthesized: 4 } })
    expect(find("transcribe-all").requiresConfirmation!.description(c, t, joinList)).toContain("7")
    expect(find("synth-all").requiresConfirmation!.description(c, t, joinList)).toContain("4")
  })

  // AQU-1109: Change voice converts existing takes; it never generates from text.
  it("offers Change voice only when a take can be re-voiced, and says so", () => {
    resetChangeVoiceQualityCacheForTests()
    const change = find("change-voice-all")
    const counts = (voiceChangeable: number) =>
      ctx({ activeFileId: "f1", audioCounts: { untranscribed: 0, unsynthesized: 9, voiceChangeable } })
    expect(change.isAvailable!(counts(0))).toBe(false)
    expect(change.isAvailable!(ctx({ activeFileId: "f1" }))).toBe(false)
    expect(change.isAvailable!(ctx({ activeFileId: null, audioCounts: { untranscribed: 0, unsynthesized: 0, voiceChangeable: 3 } }))).toBe(false)
    expect(change.isAvailable!(counts(3))).toBe(true)
    const body = change.requiresConfirmation!.description(counts(3), t)
    expect(body).toContain("3 cells")
    expect(body).toContain("Standard quality")
    expect(body).toContain("Nothing is generated from text.")
  })
})

// ── AQU-490: bulk recording validation ─────────────────────────────────────
//
// Sam's ruling: a SEPARATE action beside the text one, in both places a bulk
// text validate lives. Never combined — a reviewer signing off translations
// has not listened to the recordings, and one button doing both would collect
// sign-off nobody meant to give.
describe("batch-validate-audio", () => {
  const action = () => workspaceActions.find((a) => a.id === "batch-validate-audio")!
  const withRole = (roleLevel: number, overrides: Partial<WorkspaceActionContext> = {}) => ctx({
    project: { ...project, syncRole: { level: roleLevel, name: "t", source: "server", fetchedAt: "2026-01-01T00:00:00Z" } },
    activeFileId: "f1",
    ...overrides,
  })

  it("exists as its own action, distinct from the text one", () => {
    expect(action()).toBeDefined()
    expect(workspaceActions.find((a) => a.id === "batch-validate")).toBeDefined()
  })

  // A text-only project must not grow a menu item it can do nothing with.
  it("hides itself when the file has no take this user could validate", () => {
    expect(action().isAvailable(withRole(600, { audioCounts: { untranscribed: 0, unsynthesized: 0, validatableTakes: 0 } }))).toBe(false)
    expect(action().isAvailable(withRole(600, { audioCounts: { untranscribed: 3, unsynthesized: 2 } }))).toBe(false)
  })

  it("appears once there is something to sign off", () => {
    expect(action().isAvailable(withRole(600, { audioCounts: { untranscribed: 0, unsynthesized: 0, validatableTakes: 4 } }))).toBe(true)
  })

  // Reviewer floor, same as the text action — and the same as the server's.
  it("stays hidden below the reviewer floor", () => {
    const counts = { untranscribed: 0, unsynthesized: 0, validatableTakes: 4 }
    expect(action().isAvailable(withRole(ROLE.COMMENTER, { audioCounts: counts }))).toBe(false)
    expect(action().isAvailable(withRole(ROLE.REVIEWER, { audioCounts: counts }))).toBe(true)
  })

  it("runs its own handler, never the text one", () => {
    const runBatchValidate = vi.fn()
    const runBatchValidateAudio = vi.fn()
    action().run(withRole(600), { runBatchValidate, runBatchValidateAudio } as never)
    expect(runBatchValidateAudio).toHaveBeenCalledTimes(1)
    expect(runBatchValidate).not.toHaveBeenCalled()
  })
})
