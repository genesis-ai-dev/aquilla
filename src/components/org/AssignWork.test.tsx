import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { AssignWork } from "./AssignWork"

vi.mock("@/lib/frontier/orgs", () => ({ listOrgMembers: vi.fn() }))
vi.mock("@/lib/sync/assignments", () => ({ createAssignment: vi.fn(), getFileChapters: vi.fn() }))

import { listOrgMembers } from "@/lib/frontier/orgs"
import { createAssignment, getFileChapters } from "@/lib/sync/assignments"

const mockList = vi.mocked(listOrgMembers)
const mockCreate = vi.mocked(createAssignment)
const mockChapters = vi.mocked(getFileChapters)

const members = [
  { userId: 2, username: "anna", role: { level: 400, name: "contributor" } },
] as unknown as Awaited<ReturnType<typeof listOrgMembers>>

const files = [
  { id: "f1", name: "John" },
  { id: "f2", name: "Mark" },
]

// Drive the shadcn (Base UI) Select: open the trigger, hover-highlight the
// option, commit with Enter fired on the option itself. Under happy-dom
// clicking an option does not reliably commit a selection, but the keyboard
// path does (recipe adapted from AssignModal.test.tsx; Enter targets the
// option because outside a Dialog focus may never enter the popup).
// Waits for the trigger to render the chosen option's label.
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = screen.getByRole("combobox", { name: triggerName })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  const label = option.textContent ?? ""
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
  await waitFor(() => expect(trigger.textContent).toContain(label))
}

function renderAssign(onAssigned = vi.fn()) {
  return render(
    <AssignWork projectId="p1" files={files} orgId={1} jwt="jwt" author="wendi" onAssigned={onAssigned} />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockChapters.mockResolvedValue([]) // default: no chapters unless a test sets them
})
afterEach(() => vi.restoreAllMocks())

describe("AssignWork", () => {
  it("collapses to an Assign… button", () => {
    renderAssign()
    expect(screen.getByRole("button", { name: "Assign…" })).toBeInTheDocument()
  })

  it("opens, loads members, and emits a book-scope assignment.create", async () => {
    mockList.mockResolvedValue(members)
    mockCreate.mockResolvedValue("as-new")
    const onAssigned = vi.fn()
    renderAssign(onAssigned)

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    // Picking "anna" waits for the member list to load into the popup.
    await pickSelectOption(/^assignee$/i, /^anna$/)
    // Book defaults to the first file (John); chapter left empty → book scope.
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          fileId: "f1",
          author: "wendi",
          assigneeUserId: 2,
          scopeKind: "books",
          scope: [{ fileId: "f1" }],
          scopeLabel: "John",
        }),
      ),
    )
    expect(onAssigned).toHaveBeenCalled()
    // On success the panel collapses back to the "Assign…" button (AQU-336);
    // the expanded form (and its assignee select) is gone.
    expect(await screen.findByRole("button", { name: "Assign…" })).toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Assign work" })).not.toBeInTheDocument()
  })

  it("emits a chapter-scope assignment when one chapter is checked", async () => {
    mockList.mockResolvedValue(members)
    mockChapters.mockResolvedValue(["GEN 1", "GEN 2"])
    mockCreate.mockResolvedValue("as-2")
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await pickSelectOption(/^assignee$/i, /^anna$/)
    // The file's chapters load into the checkbox picker; click the label text
    // to toggle the Base UI checkbox (recipe from AssignModal.test.tsx).
    fireEvent.click(await screen.findByText("GEN 1"))
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeKind: "chapters",
          scope: [{ fileId: "f1", chapter: "GEN 1" }],
          scopeLabel: "John · GEN 1",
        }),
      ),
    )
    expect(mockChapters).toHaveBeenCalledWith("jwt", "p1", "f1")
  })

  // AQU-677: multiple chapters → ONE assignment.create whose scope[] lists them
  // in canonical order (not click order), with a combined label.
  it("emits a single multi-chapter assignment when several chapters are checked", async () => {
    mockList.mockResolvedValue(members)
    mockChapters.mockResolvedValue(["GEN 1", "GEN 2", "GEN 3"])
    mockCreate.mockResolvedValue("as-3")
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await pickSelectOption(/^assignee$/i, /^anna$/)
    // Check out of canonical order to prove the scope[] is re-ordered.
    fireEvent.click(await screen.findByText("GEN 3"))
    fireEvent.click(screen.getByText("GEN 1"))
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeKind: "chapters",
          scope: [
            { fileId: "f1", chapter: "GEN 1" },
            { fileId: "f1", chapter: "GEN 3" },
          ],
          scopeLabel: "John · GEN 1, GEN 3",
        }),
      ),
    )
    // Exactly one assignment.create — not one per chapter.
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  // Regression guard: checking none still assigns the whole book.
  it("assigns the whole book when no chapter is checked", async () => {
    mockList.mockResolvedValue(members)
    mockChapters.mockResolvedValue(["GEN 1", "GEN 2"])
    mockCreate.mockResolvedValue("as-4")
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await pickSelectOption(/^assignee$/i, /^anna$/)
    // Wait for chapters to load, then assign without checking any.
    await screen.findByText("GEN 1")
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeKind: "books",
          scope: [{ fileId: "f1" }],
          scopeLabel: "John",
        }),
      ),
    )
  })

  it("surfaces a server rejection (e.g. role too low)", async () => {
    mockList.mockResolvedValue(members)
    mockCreate.mockRejectedValue(new Error("role too low for assignment.create"))
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await pickSelectOption(/^assignee$/i, /^anna$/)
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    expect(await screen.findByText(/role too low/)).toBeInTheDocument()
    expect(mockCreate).toHaveBeenCalled()
    // On failure the panel must stay open so the error is visible and the
    // assign can be retried (AQU-336 must not collapse on the error path).
    expect(screen.getByRole("group", { name: "Assign work" })).toBeInTheDocument()
  })
})

// ── AQU-496: self-assign carve-out ──────────────────────────────────────────
describe("AssignWork — self-assign carve-out (AQU-496)", () => {
  function renderSelfAssign(onAssigned = vi.fn()) {
    return render(
      <AssignWork
        projectId="p1"
        files={files}
        orgId={1}
        jwt="jwt"
        author="anna"
        roleLevel={400} // ROLE.CONTRIBUTOR — below lead
        allowSelfAssignment={true}
        callerUserId={2} // matches members[0] (anna)
        onAssigned={onAssigned}
      />,
    )
  }

  it("locks the assignee picker to the caller and emits assignment.create for their own userId", async () => {
    mockList.mockResolvedValue(members)
    mockCreate.mockResolvedValue("as-self")
    const onAssigned = vi.fn()
    renderSelfAssign(onAssigned)

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    const trigger = await screen.findByRole("combobox", { name: /^assignee$/i })
    expect(trigger.textContent).toMatch(/anna/i)
    expect((trigger as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeUserId: 2 }),
      ),
    )
    expect(onAssigned).toHaveBeenCalled()
  })

  it("shows explanatory copy that self-assignment is on", async () => {
    mockList.mockResolvedValue(members)
    renderSelfAssign()
    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    expect(await screen.findByText(/self-assignment is on/i)).toBeInTheDocument()
  })
})
