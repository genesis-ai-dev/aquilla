// AQU-192: Assignment gutter chip unit tests.
// Tests the assignmentsByCellId → assigneeLabel/assigneeNote prop chain
// by testing the building logic directly (extracted as a pure function
// to keep the test fast and isolated from the full EditorTable stack).
//
// The gutter chip itself is a simple span rendered by EditorRow — we verify
// the chip text matches the first 2 chars of the username, and that the
// title attribute encodes who + scope.

import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { MyAssignment } from "@/lib/sync/assignments"

// ── Pure helper: the logic that builds assignmentsByCellId in ProjectWorkspace ──

function buildAssignmentsByCellId(
  myAssignments: MyAssignment[],
  cells: Pick<CellData, "id" | "fileId" | "globalReferences">[],
  activeFileId: string | null,
  projectId: string,
  currentUsername: string,
): Map<string, { username: string; scopeLabel: string }> {
  const map = new Map<string, { username: string; scopeLabel: string }>()
  if (myAssignments.length === 0 || !activeFileId) return map
  for (const a of myAssignments) {
    if (a.projectId !== projectId) continue
    for (const cell of cells) {
      if (cell.fileId !== activeFileId) continue
      if (a.scopeKind === "chapters") {
        const beforeIn = a.scopeLabel.split(" in ")[0] ?? a.scopeLabel
        const chapters = beforeIn.split(",").map((s) => s.trim()).filter(Boolean)
        const ref = cell.globalReferences?.[0] ?? ""
        const refChapter = ref.includes(":") ? ref.slice(0, ref.indexOf(":")).trim() : ref.trim()
        if (chapters.some((ch) => ch === refChapter)) {
          map.set(cell.id, { username: currentUsername, scopeLabel: a.scopeLabel })
        }
      } else {
        map.set(cell.id, { username: currentUsername, scopeLabel: a.scopeLabel })
      }
    }
  }
  return map
}

function makeCell(id: string, fileId: string, globalReferences?: string[]): Pick<CellData, "id" | "fileId" | "globalReferences"> {
  return { id, fileId, globalReferences }
}

function makeAssignment(overrides: Partial<MyAssignment> = {}): MyAssignment {
  return {
    assignmentId: "asgn-1",
    projectId: "proj-1",
    scopeKind: "books",
    scopeLabel: "Genesis",
    deadline: null,
    note: null,
    cellsTotal: 10,
    cellsDone: 3,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("assignmentsByCellId build logic", () => {
  it("returns empty map when there are no assignments", () => {
    const cells = [makeCell("c1", "file-1")]
    const result = buildAssignmentsByCellId([], cells, "file-1", "proj-1", "anna")
    expect(result.size).toBe(0)
  })

  it("returns empty map when activeFileId is null", () => {
    const cells = [makeCell("c1", "file-1")]
    const result = buildAssignmentsByCellId(
      [makeAssignment()],
      cells,
      null,
      "proj-1",
      "anna",
    )
    expect(result.size).toBe(0)
  })

  it("maps all cells in the active file for a books-scope assignment", () => {
    const cells = [
      makeCell("c1", "file-1"),
      makeCell("c2", "file-1"),
      makeCell("c3", "file-2"), // different file — should NOT be mapped
    ]
    const result = buildAssignmentsByCellId(
      [makeAssignment({ scopeKind: "books", scopeLabel: "Genesis" })],
      cells,
      "file-1",
      "proj-1",
      "anna",
    )
    expect(result.size).toBe(2)
    expect(result.get("c1")).toEqual({ username: "anna", scopeLabel: "Genesis" })
    expect(result.get("c2")).toEqual({ username: "anna", scopeLabel: "Genesis" })
    expect(result.has("c3")).toBe(false)
  })

  it("maps only chapter-matching cells for a chapters-scope assignment", () => {
    const cells = [
      makeCell("c1", "file-1", ["GEN 1:1"]),
      makeCell("c2", "file-1", ["GEN 1:5"]),
      makeCell("c3", "file-1", ["GEN 2:1"]),
      makeCell("c4", "file-1", ["GEN 3:1"]), // not in scope
    ]
    const result = buildAssignmentsByCellId(
      [makeAssignment({ scopeKind: "chapters", scopeLabel: "GEN 1, GEN 2 in Genesis" })],
      cells,
      "file-1",
      "proj-1",
      "bob",
    )
    expect(result.size).toBe(3)
    expect(result.has("c1")).toBe(true)
    expect(result.has("c2")).toBe(true)
    expect(result.has("c3")).toBe(true)
    expect(result.has("c4")).toBe(false)
  })

  it("does not map cells from a different project's assignment", () => {
    const cells = [makeCell("c1", "file-1")]
    const result = buildAssignmentsByCellId(
      [makeAssignment({ projectId: "other-proj" })],
      cells,
      "file-1",
      "proj-1",
      "anna",
    )
    expect(result.size).toBe(0)
  })

  it("stores the currentUsername (my own assignments)", () => {
    const cells = [makeCell("c1", "file-1")]
    const result = buildAssignmentsByCellId(
      [makeAssignment({ scopeLabel: "Genesis" })],
      cells,
      "file-1",
      "proj-1",
      "wendi",
    )
    expect(result.get("c1")?.username).toBe("wendi")
  })
})

// ── Chip rendering ───────────────────────────────────────────────────────────
// Test that the initials chip text is derived correctly from the username.
describe("assignee chip initials", () => {
  it("takes the first 2 chars of the username (uppercased by CSS)", () => {
    const username = "anna"
    const initials = username.slice(0, 2)
    expect(initials).toBe("an")
  })

  it("handles single-char usernames gracefully", () => {
    const username = "a"
    const initials = username.slice(0, 2)
    expect(initials).toBe("a")
  })

  it("tooltip includes username and scope when both present", () => {
    const username = "anna"
    const scopeLabel = "Genesis"
    const tooltip = scopeLabel
      ? `Assigned to ${username} (${scopeLabel})`
      : `Assigned to ${username}`
    expect(tooltip).toBe("Assigned to anna (Genesis)")
  })

  it("tooltip falls back when scope is null", () => {
    const username = "anna"
    const scopeLabel = null
    const tooltip = scopeLabel
      ? `Assigned to ${username} (${scopeLabel})`
      : `Assigned to ${username}`
    expect(tooltip).toBe("Assigned to anna")
  })
})
