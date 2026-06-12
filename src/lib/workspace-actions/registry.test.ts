import { describe, it, expect, vi } from "vitest"
import { getDefaultAction, getVisibleActions, workspaceActions } from "./registry"
import type { WorkspaceAction, WorkspaceActionContext } from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"

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

describe("export org-policy gate (FRO-253)", () => {
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
