import { describe, it, expect, vi } from "vitest"
import { getDefaultAction, getVisibleActions, workspaceActions, completionBatchSizeFor, MAX_BATCH_COMPLETIONS } from "./registry"
import type { WorkspaceAction, WorkspaceActionContext } from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"

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

function mockActions(): WorkspaceAction[] {
  return [
    {
      id: "import-new", label: "+ Import",
      group: "primary",
      isAvailable: () => true,
      isDefault: (c) => c.activeFileId == null,
      run: vi.fn(),
    },
    {
      id: "run-completions", label: "Run completions",
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
      id: "export", label: "Export",
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
      { id: "a", label: "A", group: "primary", isAvailable: () => false, run: vi.fn() },
      { id: "b", label: "B", group: "primary", isAvailable: () => true, run: vi.fn() },
    ]
    const def = getDefaultAction(acts, ctx())
    expect(def.id).toBe("b")
  })
})

describe("export org-policy gate (AQU-253)", () => {
  // The header's duplicate "Export file" overflow item was removed, so the
  // registry action is the ONLY export entry point — it must honor the org
  // export floor, not just rely on openExportFlow's runtime no-op.
  const exportAction = workspaceActions.find((a) => a.id === "export")!

  it("hides Export when org policy forbids it", () => {
    expect(
      exportAction.isAvailable(ctx({ activeFileId: "f1", canExportByOrgPolicy: false })),
    ).toBe(false)
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

describe("AQU-503: target import is discoverable by wording", () => {
  const importIntoFile = workspaceActions.find((a) => a.id === "import-into-file")!

  it("labels the file-scoped target importer with the word 'target'", () => {
    // A PM (Anna) searching for the "Target Import" option must recognize this
    // entry by its wording. The label must name the TARGET column so it is not
    // confused with the primary "Import" (source) action.
    expect(importIntoFile.label.toLowerCase()).toContain("target")
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
    )
    expect(desc).toContain("next 3 untranslated cells")
    expect(desc).toContain("7 more after this")
  })

  it("the batch-validate confirmation notes the per-run cap when set", () => {
    const p: ProjectRecord = { ...project, completionSettings: { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "", validationBatchSize: 5 } }
    const action = workspaceActions.find((a) => a.id === "batch-validate")!
    const desc = action.requiresConfirmation!.description(
      ctx({ project: p, activeFileId: "f1", fileProgress: new Map([["f1", { translated: 10, validated: 0, total: 10 }]]) }),
    )
    expect(desc).toContain("At most 5 eligible cells are validated per run")
  })
})

describe("getVisibleActions", () => {
  it("filters out unavailable actions", () => {
    const acts: WorkspaceAction[] = [
      { id: "a", label: "A", group: "primary", isAvailable: () => false, run: vi.fn() },
      { id: "b", label: "B", group: "primary", isAvailable: () => true, run: vi.fn() },
    ]
    const visible = getVisibleActions(acts, ctx())
    expect(visible.map((a) => a.id)).toEqual(["b"])
  })
})
