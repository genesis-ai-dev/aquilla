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
    expect(await screen.findByText(/Assigned John to anna/)).toBeInTheDocument()
  })

  it("emits a chapter-scope assignment when a chapter is picked from the dropdown", async () => {
    mockList.mockResolvedValue(members)
    mockChapters.mockResolvedValue(["GEN 1", "GEN 2"])
    mockCreate.mockResolvedValue("as-2")
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await pickSelectOption(/^assignee$/i, /^anna$/)
    // The file's chapters load into the dropdown (alongside "Whole book").
    const chapterTrigger = screen.getByRole("combobox", { name: /^chapter$/i })
    fireEvent.click(chapterTrigger)
    const chapterOption = await screen.findByRole("option", { name: "GEN 1" })
    expect(screen.getByRole("option", { name: "Whole book" })).toBeInTheDocument()
    fireEvent.pointerMove(chapterOption)
    fireEvent.mouseMove(chapterOption)
    fireEvent.keyDown(chapterOption, { key: "Enter" })
    await waitFor(() => expect(chapterTrigger.textContent).toContain("GEN 1"))
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

  it("surfaces a server rejection (e.g. role too low)", async () => {
    mockList.mockResolvedValue(members)
    mockCreate.mockRejectedValue(new Error("role too low for assignment.create"))
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await pickSelectOption(/^assignee$/i, /^anna$/)
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    expect(await screen.findByText(/role too low/)).toBeInTheDocument()
    expect(mockCreate).toHaveBeenCalled()
  })
})
