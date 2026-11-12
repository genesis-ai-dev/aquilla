import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { WorkloadRollup } from "./WorkloadRollup"
import type { OrgWorkloadAssignment } from "@/lib/sync/assignments"

vi.mock("@/lib/sync/assignments", () => ({ getWorkload: vi.fn(), unassignAssignment: vi.fn() }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
import { getWorkload, unassignAssignment } from "@/lib/sync/assignments"
const mockGetWorkload = vi.mocked(getWorkload)
const mockUnassign = vi.mocked(unassignAssignment)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("WorkloadRollup", () => {
  it("renders one row per assignment, with its project + progress (AQU-494)", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", assigneeUserId: 3, username: "bob", scopeLabel: "Mark 1", cellsTotal: 4, cellsDone: 4, deadline: null },
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("Team workload")).toBeInTheDocument())
    expect(screen.getByText("anna")).toBeInTheDocument()
    // AQU-494: each row shows which project the assignment belongs to.
    expect(screen.getByText("John")).toBeInTheDocument()
    expect(screen.getByText("4/10")).toBeInTheDocument()
    expect(screen.getByText("bob")).toBeInTheDocument()
    expect(screen.getByText("Mark")).toBeInTheDocument()
    expect(screen.getByText("4/4")).toBeInTheDocument()
    expect(mockGetWorkload).toHaveBeenCalledWith("jwt", 1)
  })

  it("renders nothing when the caller is not a manager (forbidden → caught silently)", async () => {
    // Simulate what our helpers now throw: a UserError with a human message.
    // WorkloadRollup swallows any rejection so non-manager callers see nothing.
    mockGetWorkload.mockRejectedValue(
      Object.assign(new Error("You don't have permission to do that for this org."), {
        name: "UserError",
        category: "forbidden",
        status: 403,
        raw: "",
      })
    )
    const { container } = render(<WorkloadRollup jwt="jwt" orgId={1} />)
    await waitFor(() => expect(mockGetWorkload).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("Team workload")).not.toBeInTheDocument()
  })

  it("renders nothing when there are no open assignments", async () => {
    mockGetWorkload.mockResolvedValue([])
    const { container } = render(<WorkloadRollup jwt="jwt" orgId={1} action={<span>Visibility control</span>} />)
    await waitFor(() => expect(mockGetWorkload).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("Visibility control")).not.toBeInTheDocument()
  })

  it("places section actions in the rendered section header", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} action={<span>Visibility control</span>} />)

    const heading = await screen.findByText("Team workload")
    expect(heading.closest("section")).toHaveTextContent("Visibility control")
  })

  it("hides Remove when the caller is below the project's assignment floor", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
    ])
    render(
      <WorkloadRollup
        jwt="jwt"
        orgId={1}
        canUnassignProject={(projectId) => projectId !== "pa"}
      />,
    )

    await screen.findByText("Team workload")
    expect(screen.queryByRole("button", { name: /Remove assignment/ })).not.toBeInTheDocument()
  })

  it("removes a completed (100%) assignment on click — it disappears (AQU-494 bug 1)", async () => {
    // "Completed" here means 100% progress, not a completed_at flag — nothing
    // in this system ever sets completed_at (see assignments.ts service docs);
    // this is exactly the case the reporter hit: full progress, still open,
    // and previously no way to clear it at all.
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 10, deadline: null },
    ])
    mockUnassign.mockResolvedValue(undefined)
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /^Remove assignment/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Confirm removing assignment/ }))

    await waitFor(() => expect(mockUnassign).toHaveBeenCalledWith({
      jwt: "jwt",
      projectId: "pa",
      fileId: "f1",
      author: "wendi",
      assignmentId: "a1",
    }))
    // Row disappears immediately; the whole section unmounts since it was the
    // only row (renders nothing — matches the "no open assignments" case).
    await waitFor(() => expect(screen.queryByText("anna")).not.toBeInTheDocument())
  })

  it("surfaces a removal failure inline instead of silently no-op'ing", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 3, cellsDone: 1, deadline: null },
    ])
    mockUnassign.mockRejectedValue(new Error("role too low for assignment.unassign"))
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /^Remove assignment/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Confirm removing assignment/ }))

    await waitFor(() => expect(screen.getByText(/role too low/)).toBeInTheDocument())
    // Row stays — removal failed, nothing was cleared.
    expect(screen.getByText("anna")).toBeInTheDocument()
  })
})

// AQU-2294: every row says when the assignment went out and when it is due,
// using the Projects table's own overdue / due-soon rule so the two surfaces
// cannot disagree about a date.
describe("WorkloadRollup dates", () => {
  const DAY = 24 * 60 * 60 * 1000
  const row = (over: Partial<OrgWorkloadAssignment>): OrgWorkloadAssignment => ({
    assignmentId: "a1",
    projectId: "pa",
    projectName: "John",
    fileId: "f1",
    assigneeUserId: 2,
    username: "anna",
    scopeLabel: "Genesis",
    cellsTotal: 10,
    cellsDone: 4,
    deadline: null,
    ...over,
  })
  /** `YYYY-MM-DD`, the shape the server stores a deadline in. */
  const isoDay = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

  it("shows the assigned date and the due date, with no chip when the deadline is far off", async () => {
    mockGetWorkload.mockResolvedValue([
      row({ createdAt: Date.parse("2026-10-12T09:00:00Z"), deadline: isoDay(21) }),
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    expect(await screen.findByText("Assigned October 12")).toBeInTheDocument()
    expect(screen.getByText(/^Due /)).toBeInTheDocument()
    // Three weeks out is neither overdue nor due soon.
    expect(screen.queryByTestId("workload-deadline-a1")).not.toBeInTheDocument()
  })

  it("leaves out Due entirely — no placeholder, no chip — when there is no deadline", async () => {
    mockGetWorkload.mockResolvedValue([
      row({ createdAt: Date.parse("2026-10-12T09:00:00Z"), deadline: null }),
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    expect(await screen.findByText("Assigned October 12")).toBeInTheDocument()
    expect(screen.queryByText(/^Due /)).not.toBeInTheDocument()
    expect(screen.queryByText("—")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workload-deadline-a1")).not.toBeInTheDocument()
  })

  it("chips a past deadline Overdue and one inside a week Due soon", async () => {
    mockGetWorkload.mockResolvedValue([
      row({ assignmentId: "late", deadline: isoDay(-5) }),
      row({ assignmentId: "soon", username: "bob", assigneeUserId: 3, deadline: isoDay(3) }),
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    expect(await screen.findByTestId("workload-deadline-late")).toHaveTextContent("Overdue")
    expect(screen.getByTestId("workload-deadline-soon")).toHaveTextContent("Due soon")
  })

  it("renders the row without an assigned date when the server predates the field", async () => {
    // The SPA and the workers deploy separately: an older worker omits
    // createdAt, and the row must still render everything else.
    mockGetWorkload.mockResolvedValue([row({ deadline: isoDay(-5) })])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    expect(await screen.findByText("anna")).toBeInTheDocument()
    expect(screen.queryByText(/^Assigned /)).not.toBeInTheDocument()
    expect(screen.getByTestId("workload-deadline-a1")).toHaveTextContent("Overdue")
  })

  it("dates validate rows the same way as translate rows", async () => {
    const counts = (total: number, validated: number, waiting: number, changed: number) =>
      ({ total, validated, waiting, changed })
    mockGetWorkload.mockResolvedValue([
      row({
        assignmentId: "v1",
        kind: "validate",
        createdAt: Date.parse("2026-10-12T09:00:00Z"),
        deadline: isoDay(-5),
        validation: { text: counts(10, 4, 0, 0), audio: counts(10, 0, 10, 0) },
      }),
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    const group = await screen.findByTestId("workload-validations")
    expect(group).toHaveTextContent("Assigned October 12")
    expect(screen.getByTestId("workload-deadline-v1")).toHaveTextContent("Overdue")
  })
})

// AQU-1969: validate assignments read the assignee's own approvals, under
// their own heading, furthest behind first.
describe("WorkloadRollup validators", () => {
  const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })
  const base = { projectId: "pa", projectName: "Torah", fileId: "f1", deadline: null }

  it("lists validators apart from translators, furthest behind first, in the shared wording", async () => {
    mockGetWorkload.mockResolvedValue([
      // Newest first from the server.
      { ...base, assignmentId: "v-near", assigneeUserId: 3, username: "bo", scopeLabel: "Deuteronomy 11", cellsTotal: 10, cellsDone: 9, kind: "validate", validation: { text: counts(10, 9, 0, 0), audio: counts(10, 0, 10, 0) } },
      { ...base, assignmentId: "v-far", assigneeUserId: 2, username: "ana", scopeLabel: "Deuteronomy 1–10", cellsTotal: 40, cellsDone: 34, kind: "validate", validation: { text: counts(40, 34, 0, 2), audio: counts(40, 3, 30, 1) } },
      { ...base, assignmentId: "t1", assigneeUserId: 4, username: "tom", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, kind: "translate" },
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    const group = await screen.findByTestId("workload-validations")
    expect(screen.getByText("Validation assignments")).toBeInTheDocument()
    const order = [...group.querySelectorAll("[data-testid^=workload-validation-v]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => !id?.includes("-text-") && !id?.includes("-audio-"))
    expect(order).toEqual(["workload-validation-v-far", "workload-validation-v-near"])
    expect(screen.getByTestId("workload-validation-text-v-far").textContent).toBe(
      "Text validated 34 of 40 · 6 left · 2 changed since",
    )
    // Three of her lines have recordings: the audio line is there.
    expect(screen.getByTestId("workload-validation-audio-v-far").textContent).toBe(
      "Audio validated 3 of 40 · 7 left · 1 changed since · waiting on a recording (30)",
    )
    // The translator's row is outside the group and reads as it always has.
    expect(group.textContent).not.toContain("tom")
    expect(screen.getByText("4/10")).toBeInTheDocument()
  })
})

// AQU-2293: each list caps at five rows behind the shared Show more / Show all
// / Show fewer control, and the two cap independently.
describe("WorkloadRollup paging", () => {
  const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })
  const translate = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      assignmentId: `t${i + 1}`,
      projectId: "pa",
      projectName: "John",
      fileId: `f${i + 1}`,
      assigneeUserId: 2,
      username: "anna",
      scopeLabel: `Chapter ${i + 1}`,
      cellsTotal: 10,
      cellsDone: i,
      deadline: null,
    }))
  const validate = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      assignmentId: `v${i + 1}`,
      projectId: "pa",
      projectName: "John",
      fileId: `vf${i + 1}`,
      assigneeUserId: 3,
      username: "bob",
      scopeLabel: `Psalm ${i + 1}`,
      cellsTotal: 10,
      cellsDone: 1,
      deadline: null,
      kind: "validate" as const,
      // Each one further behind than the last, so the sort order is stable.
      validation: { text: counts(10, i, 0, 0), audio: counts(10, 0, 10, 0) },
    }))

  const translateRowCount = () =>
    document.querySelectorAll("#workload-translate-list > div").length
  const validateRowCount = () =>
    document.querySelectorAll("#workload-validate-list > div").length

  it("caps the translate list at five rows and reveals the rest a batch at a time or all at once", async () => {
    mockGetWorkload.mockResolvedValue(translate(12))
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await screen.findByText("Team workload")
    expect(translateRowCount()).toBe(5)
    expect(screen.getByText("Chapter 5")).toBeInTheDocument()
    expect(screen.queryByText("Chapter 6")).not.toBeInTheDocument()
    expect(screen.getByTestId("workload-translate-show-more").textContent).toBe("Show 5 more")
    expect(screen.getByTestId("workload-translate-show-all").textContent).toBe("Show all (12)")

    fireEvent.click(screen.getByTestId("workload-translate-show-more"))
    expect(translateRowCount()).toBe(10)
    expect(screen.getByText("Chapter 10")).toBeInTheDocument()
    // Only two rows are left hidden, so another batch would equal "Show all".
    expect(screen.queryByTestId("workload-translate-show-more")).not.toBeInTheDocument()
    expect(screen.getByTestId("workload-translate-show-all")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workload-translate-show-all"))
    expect(translateRowCount()).toBe(12)
    expect(screen.queryByTestId("workload-translate-show-all")).not.toBeInTheDocument()
    expect(screen.getByTestId("workload-translate-show-fewer").textContent).toBe("Show fewer")

    fireEvent.click(screen.getByTestId("workload-translate-show-fewer"))
    expect(translateRowCount()).toBe(5)
    expect(screen.queryByText("Chapter 6")).not.toBeInTheDocument()
  })

  it("caps the validation list on its own, without a batch control when fewer than a batch is hidden", async () => {
    mockGetWorkload.mockResolvedValue([...translate(12), ...validate(7)])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await screen.findByTestId("workload-validations")
    expect(validateRowCount()).toBe(5)
    expect(screen.queryByTestId("workload-validate-show-more")).not.toBeInTheDocument()
    expect(screen.getByTestId("workload-validate-show-all").textContent).toBe("Show all (7)")

    // Expanding one list leaves the other exactly as it was.
    fireEvent.click(screen.getByTestId("workload-validate-show-all"))
    expect(validateRowCount()).toBe(7)
    expect(translateRowCount()).toBe(5)
    expect(screen.getByTestId("workload-translate-show-all").textContent).toBe("Show all (12)")
  })

  it("shows no paging controls on a list of five or fewer rows", async () => {
    mockGetWorkload.mockResolvedValue([...translate(5), ...validate(3)])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await screen.findByText("Team workload")
    expect(translateRowCount()).toBe(5)
    expect(validateRowCount()).toBe(3)
    for (const list of ["translate", "validate"]) {
      for (const control of ["show-more", "show-all", "show-fewer"]) {
        expect(screen.queryByTestId(`workload-${list}-${control}`)).not.toBeInTheDocument()
      }
    }
  })

  it("pulls the next hidden row up when a visible row is removed from a capped list", async () => {
    mockGetWorkload.mockResolvedValue(translate(12))
    mockUnassign.mockResolvedValue(undefined)
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await screen.findByText("Team workload")
    expect(screen.queryByText("Chapter 6")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Remove assignment: Chapter 1 (anna)" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm removing assignment: Chapter 1 (anna)" }))

    await waitFor(() => expect(screen.queryByText("Chapter 1")).not.toBeInTheDocument())
    // Still five rows: the sixth slid up into the cap, and the total dropped.
    expect(translateRowCount()).toBe(5)
    expect(screen.getByText("Chapter 6")).toBeInTheDocument()
    expect(screen.getByTestId("workload-translate-show-all").textContent).toBe("Show all (11)")
  })
})
