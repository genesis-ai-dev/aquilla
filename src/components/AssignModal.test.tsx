// FRO-192: AssignModal tests — scope→event payload wiring, role gate.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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
    { id: "file-1", name: "Genesis", type: "usfm" as const, createdAt: "2026-01-01T00:00:00Z", cellCount: 10, corpusMarker: "OT" },
    { id: "file-2", name: "Exodus", type: "usfm" as const, createdAt: "2026-01-01T00:00:00Z", cellCount: 10, corpusMarker: "OT" },
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
  it("renders nothing when roleLevel is below PROJECT_LEAD (allowSelfAssignment defaults to off)", () => {
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

// ── AQU-496: self-assign carve-out ──────────────────────────────────────────
describe("self-assign carve-out (AQU-496)", () => {
  const SELF_MEMBER = { userId: 42, username: "anna", role: { level: 400, name: "contributor", source: "override" as const }, secondarySources: [] }
  const SELF_ASSIGN_PROPS = {
    ...BASE_PROPS,
    roleLevel: ROLE.CONTRIBUTOR,
    allowSelfAssignment: true,
    callerUserId: 42,
    members: [SELF_MEMBER, BASE_PROPS.members[1]],
  }

  it("still renders nothing below CONTRIBUTOR (VIEWER) even with allowSelfAssignment on", () => {
    const { container } = render(
      <AssignModal {...SELF_ASSIGN_PROPS} roleLevel={ROLE.VIEWER} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders for a CONTRIBUTOR when allowSelfAssignment is on", () => {
    render(<AssignModal {...SELF_ASSIGN_PROPS} />)
    expect(screen.getByText("Assign work")).toBeTruthy()
  })

  it("locks the assignee picker to the caller and disables it", () => {
    render(<AssignModal {...SELF_ASSIGN_PROPS} />)
    const trigger = screen.getByRole("combobox", { name: /assign to/i })
    expect(trigger.textContent).toMatch(/anna/i)
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    // "bob" (a different member) must never appear as a pickable option.
    expect(screen.queryByText("bob")).toBeNull()
  })

  it("submits assignment.create with the caller's own userId as assigneeUserId", async () => {
    render(<AssignModal {...SELF_ASSIGN_PROPS} />)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const args = mockCreate.mock.calls[0][0]
    expect(args.assigneeUserId).toBe(42)
  })

  it("shows explanatory copy that self-assignment is on", () => {
    render(<AssignModal {...SELF_ASSIGN_PROPS} />)
    expect(screen.getByText(/self-assignment is on/i)).toBeTruthy()
  })

  it("fails closed (no eligible assignee, submit blocked) when callerUserId can't be resolved", () => {
    render(<AssignModal {...SELF_ASSIGN_PROPS} callerUserId={null} />)
    // Trigger renders no committed label — placeholder only, nothing to pick.
    const assignBtn = screen.getByRole("button", { name: /^assign$/i })
    expect((assignBtn as HTMLButtonElement).disabled).toBe(true)
  })
})

// Base UI Select renders a combobox trigger; options live in a portaled
// popup. Under happy-dom, clicks on options don't commit a selection when the
// select sits inside a modal Dialog — but hover-highlighting the option and
// pressing Enter does (the keyboard path Base UI supports natively).
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
  // Selection committed when the trigger renders the chosen label.
  await waitFor(() => {
    expect(trigger.textContent).toMatch(optionName)
  })
}

// ── Scope: verses (all verses in file) ──────────────────────────────────────
describe("verses scope", () => {
  it("calls createAssignment with books scope covering the active file", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    // Default scope = verses since selectedCellIds is empty
    // Pick a member
    await pickSelectOption(/assign to/i, /anna/)
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
    const scopeTrigger = screen.getByRole("combobox", { name: /scope/i })
    expect(scopeTrigger.textContent).toMatch(/current selection/i)
    // Assign
    await pickSelectOption(/assign to/i, /bob/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const args = mockCreate.mock.calls[0][0]
    expect(args.scopeKind).toBe("books")
    expect(args.scopeLabel).toContain("3 verse(s)")
    expect(args.assigneeUserId).toBe(99)
  })
})

// ── Scope: books ─────────────────────────────────────────────────────────────
describe("books scope", () => {
  it("calls createAssignment with all selected file ids", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    // Switch to books scope
    await pickSelectOption(/scope/i, /books \(files\)/i)
    // Select both files via their labeled checkboxes (clicking the label
    // toggles the Base UI checkbox through its hidden labelable input)
    fireEvent.click(screen.getByText("Genesis"))
    fireEvent.click(screen.getByText("Exodus"))
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true") // Genesis
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("true") // Exodus
    // Pick member
    await pickSelectOption(/assign to/i, /anna/)
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
    await pickSelectOption(/scope/i, /books \(files\)/i)
    await pickSelectOption(/assign to/i, /anna/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(screen.getByText(/select at least one/i)).toBeTruthy())
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// ── Scope: chapters ──────────────────────────────────────────────────────────
describe("chapters scope", () => {
  it("calls createAssignment with chapters scope for selected chapters", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    await pickSelectOption(/scope/i, /chapters/i)
    // Wait for chapters to load
    await waitFor(() => expect(mockChapters).toHaveBeenCalledWith("test-jwt", "proj-1", "file-1"))
    await waitFor(() => screen.getByText("GEN 1"))
    // Check GEN 1 and GEN 2 via their labeled checkboxes
    fireEvent.click(screen.getByText("GEN 1"))
    fireEvent.click(screen.getByText("GEN 2"))
    const chCheckboxes = screen.getAllByRole("checkbox")
    expect(chCheckboxes[0].getAttribute("aria-checked")).toBe("true") // GEN 1
    expect(chCheckboxes[1].getAttribute("aria-checked")).toBe("true") // GEN 2
    await pickSelectOption(/assign to/i, /anna/)
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

  // AQU-495 regression: onAssigned is the sole hook the open-assignments /
  // assigned-to-me lists rely on to revalidate after a create — a caller
  // that doesn't wire this up (or wires it to an unrelated refresh, as
  // ProjectOverview.tsx's Team card currently does — see SWARM-TODO(AQU-495)
  // in src/lib/sync/assignments.ts) reproduces the "no open assignments
  // until manual refresh" bug from the walkthrough.
  it("calls onAssigned and closes after successful creation", async () => {
    const onAssigned = vi.fn()
    const onOpenChange = vi.fn()
    render(<AssignModal {...BASE_PROPS} onAssigned={onAssigned} onOpenChange={onOpenChange} />)
    await pickSelectOption(/assign to/i, /anna/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
