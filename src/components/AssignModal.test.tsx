// AQU-192: AssignModal tests — scope→event payload wiring, role gate.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AssignModal } from "./AssignModal"

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock("@/lib/sync/assignments", () => ({
  createAssignment: vi.fn(),
  createBulkFileAssignments: vi.fn(),
  getFileChapters: vi.fn(),
  AssignmentEmitError: class AssignmentEmitError extends Error {
    constructor(message: string) { super(message); this.name = "AssignmentEmitError" }
  },
}))
vi.mock("@/lib/frontier/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/roles")>()
  return { ...actual }
})

import { createAssignment, createBulkFileAssignments, getFileChapters } from "@/lib/sync/assignments"
import { ROLE } from "@/lib/frontier/roles"

const mockCreate = vi.mocked(createAssignment)
const mockBulkCreate = vi.mocked(createBulkFileAssignments)
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
  mockBulkCreate.mockImplementation(async (args) =>
    args.entries.map((e) => ({ fileId: e.fileId, assignmentId: `assign-${e.fileId}` })),
  )
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

  it("fails closed (no eligible assignee, submit blocked) when callerUserId can't be resolved", async () => {
    render(<AssignModal {...SELF_ASSIGN_PROPS} callerUserId={null} />)
    // Trigger renders no committed label — placeholder only, nothing to pick.
    // The submit button stays enabled (click-to-validate), but clicking it
    // must surface an inline error and never emit assignment.create.
    fireEvent.click(screen.getByRole("button", { name: /^assign$/i }))
    expect(await screen.findByText(/select a member/i)).toBeTruthy()
    expect(mockCreate).not.toHaveBeenCalled()
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

// ── Scope: books (AQU-497 bulk/season assign) ────────────────────────────────
describe("books scope", () => {
  it("calls createBulkFileAssignments once per selected file, not one event covering both", async () => {
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
    await waitFor(() => expect(mockBulkCreate).toHaveBeenCalledTimes(1))
    // AQU-497: one PM action (one submit click) resolves to ONE
    // createBulkFileAssignments call carrying an entry PER file — the "unit
    // count" the ticket's acceptance criteria wants verified — rather than a
    // single assignment.create whose scope[] spans both files. This is what
    // makes each file individually removable afterward (see the doc comment
    // on createBulkFileAssignments in src/lib/sync/assignments.ts).
    const args = mockBulkCreate.mock.calls[0][0]
    expect(args.entries).toHaveLength(2)
    expect(args.entries.map((e) => e.fileId).sort()).toEqual(["file-1", "file-2"])
    expect(args.assigneeUserId).toBe(42)
    // Never falls back to the single-event path for this scope.
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("labels each bulk entry with its shared corpusMarker group (season), so removal is traceable to a season", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    await pickSelectOption(/scope/i, /books \(files\)/i)
    fireEvent.click(screen.getByText("Genesis"))
    fireEvent.click(screen.getByText("Exodus"))
    await pickSelectOption(/assign to/i, /anna/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockBulkCreate).toHaveBeenCalledTimes(1))
    const entries = mockBulkCreate.mock.calls[0][0].entries
    expect(entries.find((e) => e.fileId === "file-1")?.scopeLabel).toBe("OT · Genesis")
    expect(entries.find((e) => e.fileId === "file-2")?.scopeLabel).toBe("OT · Exodus")
  })

  it("'Select all' on the season/corpus group selects every file in that group in one click", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    await pickSelectOption(/scope/i, /books \(files\)/i)
    // Both fixture files share corpusMarker "OT" -> one group with a
    // "Select all" affordance; this is the actual "assign a whole season at
    // once" click-path (AQU-497 acceptance #1).
    fireEvent.click(screen.getByRole("button", { name: /select all/i }))
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true")
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("true")
    await pickSelectOption(/assign to/i, /anna/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockBulkCreate).toHaveBeenCalledTimes(1))
    expect(mockBulkCreate.mock.calls[0][0].entries).toHaveLength(2)
  })

  it("applies one shared deadline to every file in the bulk batch", async () => {
    render(<AssignModal {...BASE_PROPS} />)
    await pickSelectOption(/scope/i, /books \(files\)/i)
    fireEvent.click(screen.getByRole("button", { name: /select all/i }))
    await pickSelectOption(/assign to/i, /anna/)
    const deadlineInput = screen.getByLabelText(/deadline/i)
    fireEvent.change(deadlineInput, { target: { value: "2026-08-15" } })
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockBulkCreate).toHaveBeenCalledTimes(1))
    const args = mockBulkCreate.mock.calls[0][0]
    expect(args.deadline).toBeTruthy()
    expect(args.entries).toHaveLength(2)
  })

  it("surfaces partial failure without losing the assignments that succeeded", async () => {
    mockBulkCreate.mockResolvedValueOnce([
      { fileId: "file-1", assignmentId: "assign-1" },
      { fileId: "file-2", error: "role too low" },
    ])
    render(<AssignModal {...BASE_PROPS} />)
    await pickSelectOption(/scope/i, /books \(files\)/i)
    fireEvent.click(screen.getByRole("button", { name: /select all/i }))
    await pickSelectOption(/assign to/i, /anna/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(screen.getByText(/1 of 2 assignment/i)).toBeTruthy())
    // A partial failure still revalidates the caller's list (one assignment
    // did land) and does NOT auto-close the modal, so the PM can see the error.
    expect(BASE_PROPS.onAssigned).toHaveBeenCalled()
    expect(BASE_PROPS.onOpenChange).not.toHaveBeenCalled()
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

// ── AQU-538 (§3.5): lane select ──────────────────────────────────────────────
describe("lane select (AQU-538)", () => {
  it("is hidden when the project has no extra lanes", () => {
    render(<AssignModal {...BASE_PROPS} />)
    expect(screen.queryByRole("combobox", { name: /language lane/i })).toBeNull()
  })

  it("renders and pre-fills from defaultLane when the project has extra lanes", () => {
    render(<AssignModal {...BASE_PROPS} targetLanes={["es", "fr"]} defaultLane="fr" />)
    const laneTrigger = screen.getByRole("combobox", { name: /language lane/i })
    expect(laneTrigger.textContent).toMatch(/fr/i)
  })

  it("threads the pre-filled lane into createAssignment as targetLang", async () => {
    render(<AssignModal {...BASE_PROPS} targetLanes={["es", "fr"]} defaultLane="es" />)
    await pickSelectOption(/assign to/i, /anna/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate.mock.calls[0][0].targetLang).toBe("es")
  })

  it("omits the lane (default) when defaultLane is '' even with extra lanes present", async () => {
    render(<AssignModal {...BASE_PROPS} targetLanes={["es", "fr"]} defaultLane="" />)
    await pickSelectOption(/assign to/i, /anna/)
    fireEvent.click(screen.getByRole("button", { name: /assign/i }))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    expect(mockCreate.mock.calls[0][0].targetLang).toBeUndefined()
  })
})

// ── Error: no member selected ────────────────────────────────────────────────
describe("validation", () => {
  it("submitting with no member selected surfaces an inline error and emits nothing", async () => {
    // Click-to-validate: the button stays enabled so the user sees the
    // validation error instead of a dead disabled control.
    render(<AssignModal {...BASE_PROPS} />)
    fireEvent.click(screen.getByRole("button", { name: /^assign$/i }))
    expect(await screen.findByText(/select a member/i)).toBeTruthy()
    expect(mockCreate).not.toHaveBeenCalled()
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
