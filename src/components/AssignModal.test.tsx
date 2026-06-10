// FRO-192: AssignModal tests — scope→event payload wiring, role gate.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import React from "react"
import { AssignModal } from "./AssignModal"

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock("@/lib/sync/assignments", () => ({
  createAssignment: vi.fn(),
  getFileChapters: vi.fn(),
  AssignmentEmitError: class AssignmentEmitError extends Error {
    constructor(message: string) { super(message); this.name = "AssignmentEmitError" }
  },
}))
vi.mock("@/lib/frontier/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/roles")>()
  return { ...actual }
})

import { createAssignment, getFileChapters } from "@/lib/sync/assignments"
import { ROLE } from "@/lib/frontier/roles"

const mockCreate = vi.mocked(createAssignment)
const mockChapters = vi.mocked(getFileChapters)

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-1",
  activeFileId: "file-1",
  projectFiles: [
    { id: "file-1", name: "Genesis", corpusMarker: "OT" },
    { id: "file-2", name: "Exodus", corpusMarker: "OT" },
  ],
  members: [
    { userId: 42, username: "anna", role: { level: 400, name: "contributor", source: "override" as const }, secondarySources: [] },
    { userId: 99, username: "bob", role: { level: 400, name: "contributor", source: "override" as const }, secondarySources: [] },
  ],
  roleLevel: ROLE.PROJECT_LEAD,
  selectedCellIds: new Set<string>(),
  jwt: "test-jwt",
  author: "wendi",
  onAssigned: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreate.mockResolvedValue("new-assignment-id")
  mockChapters.mockResolvedValue(["GEN 1", "GEN 2", "GEN 3"])
})
afterEach(() => vi.restoreAllMocks())

// ── Role gate ────────────────────────────────────────────────────────────────
describe("role gate", () => {
  it("renders nothing when roleLevel is below PROJECT_LEAD", () => {
    const { container } = render(
      <AssignModal {...BASE_PROPS} roleLevel={ROLE.CONTRIBUTOR} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the modal when roleLevel is PROJECT_LEAD", () => {
    render(<AssignModal {...BASE_PROPS} />)
    expect(screen.getByText("Assign work")).toBeTruthy()
  })
})

// ── Scope: verses (all verses in file) ──────────────────────────────────────
describe("verses scope", () => {
  it("calls createAssignment with books scope covering the active file", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    // Default scope = verses since selectedCellIds is empty
    // Pick a member
    fireEvent.change(screen.getByDisplayValue("Select member…"), { target: { value: "42" } })
    // Submit
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const args = mockCreate.mock.calls[0][0]
    expect(args.scopeKind).toBe("books")
    expect(args.scope).toEqual([{ fileId: "file-1" }])
    expect(args.scopeLabel).toContain("Genesis")
    expect(args.assigneeUserId).toBe(42)
    expect(args.jwt).toBe("test-jwt")
    expect(args.author).toBe("wendi")
    expect(args.projectId).toBe("proj-1")
  })
})

// ── Scope: selection ─────────────────────────────────────────────────────────
describe("selection scope", () => {
  it("is enabled and pre-selected when selectedCellIds is non-empty", async () => {
    const selectedCellIds = new Set(["cell-a", "cell-b", "cell-c"])
    render(<AssignModal {...BASE_PROPS} selectedCellIds={selectedCellIds} />)
    const scopeSelect = screen.getByDisplayValue(/current selection/i)
    expect(scopeSelect).toBeTruthy()
    // Assign
    fireEvent.change(screen.getByDisplayValue("Select member…"), { target: { value: "99" } })
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const args = mockCreate.mock.calls[0][0]
    expect(args.scopeKind).toBe("books")
    expect(args.scopeLabel).toContain("3 verse(s)")
    expect(args.assigneeUserId).toBe(99)
  })
})

// Helper to get the scope <select> (first select in the form)
function getScopeSelect(): HTMLSelectElement {
  const selects = document.querySelectorAll("select")
  return selects[0] as HTMLSelectElement
}

// ── Scope: books ─────────────────────────────────────────────────────────────
describe("books scope", () => {
  it("calls createAssignment with all selected file ids", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    // Switch to books scope
    fireEvent.change(getScopeSelect(), { target: { value: "books" } })
    // Select both files via checkboxes
    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0]) // Genesis
    fireEvent.click(checkboxes[1]) // Exodus
    // Pick member
    fireEvent.change(screen.getByDisplayValue("Select member…"), { target: { value: "42" } })
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const args = mockCreate.mock.calls[0][0]
    expect(args.scopeKind).toBe("books")
    expect(args.scope).toHaveLength(2)
    expect(args.scope.map((s: { fileId: string }) => s.fileId)).toContain("file-1")
    expect(args.scope.map((s: { fileId: string }) => s.fileId)).toContain("file-2")
    expect(args.scopeLabel).toContain("Genesis")
    expect(args.scopeLabel).toContain("Exodus")
  })

  it("shows an error when no files are selected", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    fireEvent.change(getScopeSelect(), { target: { value: "books" } })
    fireEvent.change(screen.getByDisplayValue("Select member…"), { target: { value: "42" } })
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(screen.getByText(/select at least one/i)).toBeTruthy())
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// ── Scope: chapters ──────────────────────────────────────────────────────────
describe("chapters scope", () => {
  it("calls createAssignment with chapters scope for selected chapters", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    fireEvent.change(getScopeSelect(), { target: { value: "chapters" } })
    // Wait for chapters to load
    await waitFor(() => expect(mockChapters).toHaveBeenCalledWith("test-jwt", "proj-1", "file-1"))
    await waitFor(() => screen.getByText("GEN 1"))
    // Check GEN 1 and GEN 2
    const chCheckboxes = screen.getAllByRole("checkbox")
    fireEvent.click(chCheckboxes[0]) // GEN 1
    fireEvent.click(chCheckboxes[1]) // GEN 2
    fireEvent.change(screen.getByDisplayValue("Select member…"), { target: { value: "42" } })
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const args = mockCreate.mock.calls[0][0]
    expect(args.scopeKind).toBe("chapters")
    expect(args.scope).toEqual([
      { fileId: "file-1", chapter: "GEN 1" },
      { fileId: "file-1", chapter: "GEN 2" },
    ])
    expect(args.scopeLabel).toContain("GEN 1")
    expect(args.scopeLabel).toContain("GEN 2")
  })
})

// ── Error: no member selected ────────────────────────────────────────────────
describe("validation", () => {
  it("assign button is disabled when no member is selected", () => {
    render(<AssignModal {...BASE_PROPS} />)
    const assignBtn = screen.getByRole("button", { name: /^assign$/i })
    expect((assignBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it("calls onAssigned and closes after successful creation", async () => {
    const onAssigned = vi.fn()
    const onOpenChange = vi.fn()
    render(<AssignModal {...BASE_PROPS} onAssigned={onAssigned} onOpenChange={onOpenChange} />)
    fireEvent.change(screen.getByDisplayValue("Select member…"), { target: { value: "42" } })
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
