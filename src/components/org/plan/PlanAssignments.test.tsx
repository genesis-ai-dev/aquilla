import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { PlanAssignments, type PlanAssignTarget } from "./PlanAssignments"
import type { UnitAssignment } from "@/lib/sync/assignments"
import { ROLE } from "@/lib/frontier/roles"

// The Assign affordance mounts AssignModal, which drags in a roster fetch and a
// chapter fetch. Neither is what this section is about; stub both so a test
// that only opens the section never opens a network path.
vi.mock("@/components/AssignModal", () => ({
  AssignModal: ({ activeFileId, defaultLane }: { activeFileId: string | null; defaultLane?: string }) => (
    <div data-testid="assign-modal-mock" data-file={activeFileId ?? ""} data-lane={defaultLane ?? ""} />
  ),
}))
vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({ members: [], isLoading: false, error: null, rosterHidden: false }),
}))

// One fixed clock, like every other plan surface's test: the component formats
// deadlines against the instant its owner captured, never against Date.now().
const NOW = Date.parse("2026-09-16T09:00:00Z")

function assignment(over: Partial<UnitAssignment> = {}): UnitAssignment {
  return {
    assignmentId: "a1",
    assigneeUserId: 2,
    username: "anna",
    scopeLabel: "Genesis",
    targetLang: "",
    deadline: null,
    cellsTotal: 950,
    translated: 940,
    validated: 938,
    recorded: 0,
    audioValidated: 0,
    ...over,
  }
}

function renderSection(
  props: Partial<React.ComponentProps<typeof PlanAssignments>> = {},
) {
  return render(
    <PlanAssignments
      assignments={[assignment()]}
      now={NOW}
      lane=""
      defaultLaneLabel="Tok Pisin"
      showAudio={false}
      minRole={ROLE.MAINTAINER}
      viewerRoleLevel={ROLE.MAINTAINER}
      ready
      {...props}
    />,
  )
}

const assignTarget: PlanAssignTarget = {
  projectId: "p1",
  activeFileId: "f1",
  files: [{ id: "f1", name: "Bible.usfm" }],
  targetLanes: ["es"],
  jwt: "jwt",
  author: "wendi",
  roleLevel: ROLE.MAINTAINER,
  allowSelfAssignment: false,
  assignmentMinRole: ROLE.PROJECT_LEAD,
  callerUserId: 1,
  onAssigned: vi.fn(),
}

describe("every lane is listed", () => {
  it("lists an assignment from another lane and chips it", () => {
    // The Assign panel that creates most assignments never pins a lane, so
    // filtering by the open lane would empty this section on every non-default
    // tab. Both rows appear; only the odd one out is labelled.
    renderSection({
      lane: "es",
      assignments: [
        assignment({ assignmentId: "a1", username: "anna", targetLang: "es" }),
        assignment({ assignmentId: "a2", username: "bob", targetLang: "" }),
      ],
    })
    expect(screen.getByTestId("plan-assignment-a1")).toBeInTheDocument()
    expect(screen.getByTestId("plan-assignment-a2")).toBeInTheDocument()
    expect(screen.getByText("anna")).toBeInTheDocument()
    expect(screen.getByText("bob")).toBeInTheDocument()

    // One chip, on the row that is NOT in the lane being viewed, naming the
    // default lane by the project's own target language (AQU-728).
    const chips = screen.getAllByTestId("plan-assignment-lane")
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent("Tok Pisin")
    expect(screen.getByTestId("plan-assignment-a2")).toContainElement(chips[0])
  })

  it("chips nothing when every assignment sits in the lane on screen", () => {
    renderSection({ lane: "", assignments: [assignment({ targetLang: "" })] })
    expect(screen.queryByTestId("plan-assignment-lane")).toBeNull()
  })
})

describe("a person's progress reads in cells", () => {
  it("shows counts, not percentages, beside the bars", () => {
    // 940/938 out of 950 rounds to "99/99%" on the bar itself — the twelve
    // cells still outstanding are exactly what a manager needs and exactly what
    // the percentage loses.
    renderSection({ assignments: [assignment()] })
    expect(screen.getByTestId("plan-assignment-text-a1")).toHaveTextContent("940/938")
    // Translation leads validation: a cell nobody has written cannot be
    // validated, so the ten untranslated cells are named first. AQU-1278: two
    // terms on one line drop the noun — this panel is three hundred pixels
    // wide, and both halves count the same cells, so "cells" twice is width
    // spent saying nothing.
    expect(screen.getByTestId("plan-assignment-left-a1")).toHaveTextContent(
      "10 to translate · 2 to validate",
    )
  })

  it("keeps the noun when only one term is left to say", () => {
    // Nothing to translate, so the line carries one term and has the room —
    // and "2 to validate" alone has nothing beside it to say two of what.
    renderSection({ assignments: [assignment({ translated: 950, validated: 948 })] })
    expect(screen.getByTestId("plan-assignment-left-a1"))
      .toHaveTextContent("2 cells to validate")
  })

  it("adds the audio pair only for a file that carries recordings", () => {
    renderSection({
      showAudio: true,
      assignments: [
        assignment({ translated: 950, validated: 950, recorded: 500, audioValidated: 0 }),
      ],
    })
    expect(screen.getByTestId("plan-assignment-audio-a1")).toHaveTextContent("500/0")
    expect(screen.getByTestId("plan-assignment-left-a1")).toHaveTextContent("450 takes to record")
  })

  it("draws no audio bar for a text-only file", () => {
    renderSection({ showAudio: false, assignments: [assignment()] })
    expect(screen.queryByTestId("plan-assignment-audio-a1")).toBeNull()
  })

  it("says so when a person has nothing left", () => {
    renderSection({
      assignments: [assignment({ translated: 950, validated: 950 })],
    })
    expect(screen.getByTestId("plan-assignment-left-a1")).toHaveTextContent("Nothing left")
  })

  it("names the deadline, or says there is none", () => {
    const { unmount } = renderSection({ assignments: [assignment({ deadline: "2026-11-01" })] })
    expect(screen.getByTestId("plan-assignment-a1")).toHaveTextContent("Genesis · 950 cells")
    // The formatted date drops the year inside the current one, so match the
    // phrase rather than pinning a shape that changes on New Year's Day.
    expect(screen.getByTestId("plan-assignment-a1")).toHaveTextContent(/due \w/)
    unmount()

    renderSection({ assignments: [assignment({ deadline: null })] })
    expect(screen.getByTestId("plan-assignment-a1")).toHaveTextContent("no deadline")
  })
})

describe("the closing coverage line", () => {
  it("counts the chapters nobody is assigned to", () => {
    renderSection({ unassignedChapters: 3 })
    expect(screen.getByTestId("plan-assignment-coverage")).toHaveTextContent(
      "3 chapters are not assigned",
    )
  })

  it("says every chapter is covered at zero", () => {
    renderSection({ unassignedChapters: 0 })
    expect(screen.getByTestId("plan-assignment-coverage")).toHaveTextContent(
      "Every chapter is assigned.",
    )
  })

  it("says nothing at all when the caller cannot know", () => {
    // Undefined is not zero. A caller with no chapter attribution must not be
    // made to claim the unit is fully assigned.
    renderSection({ unassignedChapters: undefined })
    expect(screen.queryByTestId("plan-assignment-coverage")).toBeNull()
  })
})

describe("the memberProgressViewMinRole floor", () => {
  it("renders NOTHING for a viewer below the floor — not an empty section", () => {
    const { container } = renderSection({
      minRole: ROLE.MAINTAINER,
      viewerRoleLevel: ROLE.CONTRIBUTOR,
      assign: assignTarget,
      unassignedChapters: 3,
    })
    expect(screen.queryByTestId("plan-assignments")).toBeNull()
    expect(screen.queryByTestId("plan-assignment-a1")).toBeNull()
    expect(screen.queryByTestId("plan-assign-open")).toBeNull()
    expect(screen.queryByTestId("plan-assignment-coverage")).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing while the floor is still unknown", () => {
    // `ready` is the Team card's third input for a reason: without it the
    // section flashes open on first paint and disappears once the org settings
    // land, which reads as a permissions bug.
    const { container } = renderSection({ ready: false })
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the section, and the Assign affordance, at the floor", () => {
    renderSection({ assign: assignTarget })
    expect(screen.getByTestId("plan-assignments")).toBeInTheDocument()
    expect(screen.getByTestId("plan-assign-open")).toBeInTheDocument()
  })
})

describe("the Assign affordance", () => {
  it("opens the modal pre-scoped to the unit's file and the lane on screen", () => {
    renderSection({ lane: "es", assign: assignTarget })
    expect(screen.queryByTestId("assign-modal-mock")).toBeNull()

    fireEvent.click(screen.getByTestId("plan-assign-open"))
    const modal = screen.getByTestId("assign-modal-mock")
    // Pre-scoped to the FILE, not the book — see PlanAssignTarget.activeFileId
    // for the AssignModal prop that would narrow it further.
    expect(modal).toHaveAttribute("data-file", "f1")
    expect(modal).toHaveAttribute("data-lane", "es")
  })
})
