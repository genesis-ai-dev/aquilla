import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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

describe("a person's progress reads in percentages, the counts on hover", () => {
  it("shows percentages beside the bars, and says the counts on hover", () => {
    // Percentages like every other bar (Sam, 2026-09-17, for consistency);
    // the twelve cells that "99% | 99%" rounds away are what the hover says.
    renderSection({ assignments: [assignment()] })
    expect(screen.getAllByTestId("plan-readout-figure").map((el) => el.getAttribute("aria-label")))
      .toEqual(["940 of 950 translated", "938 of 950 validated"])
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
    expect(screen.getAllByTestId("plan-readout-figure").map((el) => el.getAttribute("aria-label")))
      .toEqual([
        "950 of 950 translated", "950 of 950 validated",
        "500 of 950 recorded", "0 of 950 validated",
      ])
    // AQU-490: the second audio term, which was unreachable until a client
    // could emit a vote. This person has 500 recorded takes nobody has
    // listened to, and the row now says so instead of calling them finished.
    expect(screen.getByTestId("plan-assignment-left-a1"))
      .toHaveTextContent("450 to record · 500 takes to validate")
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

// AQU-1278: the per-unit read now returns each assignment's chapters with their
// own counts, so a person's line can finish its sentence — "2 to validate ·
// ch. 12" — instead of leaving a manager to find the chapter on the grid.
describe("where a person's outstanding work is", () => {
  const chapter = (key: string, over: Partial<{ total: number; translated: number; validated: number }> = {}) =>
    ({ key, total: 10, translated: 10, validated: 10, recorded: 0, audioValidated: 0, ...over })

  it("names the chapter the outstanding cells are in", () => {
    renderSection({
      assignments: [assignment({
        cellsTotal: 20, translated: 20, validated: 18,
        chapters: [chapter("GEN 11"), chapter("GEN 12", { validated: 8 })],
      })],
    })
    expect(screen.getByTestId("plan-assignment-left-a1"))
      .toHaveTextContent("2 to validate · ch. 12")
  })

  it("joins two short chapters with a conjunction", () => {
    renderSection({
      assignments: [assignment({
        cellsTotal: 20, translated: 20, validated: 17,
        chapters: [chapter("GEN 12", { validated: 8 }), chapter("GEN 40", { validated: 9 })],
      })],
    })
    expect(screen.getByTestId("plan-assignment-left-a1")).toHaveTextContent("ch. 12 and 40")
  })

  it("says nothing about where when every chapter is clear", () => {
    renderSection({
      assignments: [assignment({
        cellsTotal: 20, translated: 20, validated: 20, chapters: [chapter("GEN 11")],
      })],
    })
    const left = screen.getByTestId("plan-assignment-left-a1")
    expect(left).toHaveTextContent("Nothing left")
    expect(left).not.toHaveTextContent("ch.")
  })

  it("falls back to the bare shortfall when the worker sent no chapters", () => {
    // `chapters` is optional on the wire: the client and the workers deploy
    // separately, so a page talking to an older worker drops one line of
    // detail rather than crashing on `.map`.
    renderSection({ assignments: [assignment({ translated: 950, validated: 948 })] })
    const left = screen.getByTestId("plan-assignment-left-a1")
    expect(left).toHaveTextContent("2 cells to validate")
    expect(left).not.toHaveTextContent("ch.")
  })

  it("names a one-chapter book's chapter as 1, not as its book code", () => {
    renderSection({
      assignments: [assignment({
        scopeLabel: "Titus", cellsTotal: 10, translated: 10, validated: 8,
        chapters: [chapter("TIT", { validated: 8 })],
      })],
      // A one-chapter book: the bare code is the only key the unit has, and it
      // IS chapter 1.
      unitSectionKeys: ["TIT"],
    })
    expect(screen.getByTestId("plan-assignment-left-a1")).toHaveTextContent("ch. 1")
  })

  it("does not call a book's front matter chapter 1", () => {
    // The same bare "GEN" means the opposite thing here: beside GEN 1 and GEN 2
    // it is the book's front matter, which is nobody's chapter. Judged from
    // this assignment's keys alone the row read it as a one-chapter book and
    // sent the reader to Genesis 1, a chapter Anna is not assigned to.
    renderSection({
      assignments: [assignment({
        scopeLabel: "Genesis", cellsTotal: 10, translated: 10, validated: 8,
        chapters: [chapter("GEN", { validated: 8 })],
      })],
      unitSectionKeys: ["GEN", "GEN 1", "GEN 2"],
    })
    const left = screen.getByTestId("plan-assignment-left-a1")
    expect(left).toHaveTextContent("2 cells to validate")
    expect(left).not.toHaveTextContent("ch.")
  })

  it("still names the real short chapters when front matter is short too", () => {
    renderSection({
      assignments: [assignment({
        scopeLabel: "Genesis", cellsTotal: 30, translated: 30, validated: 24,
        chapters: [chapter("GEN", { validated: 8 }), chapter("GEN 2", { validated: 8 })],
      })],
      unitSectionKeys: ["GEN", "GEN 1", "GEN 2"],
    })
    const left = screen.getByTestId("plan-assignment-left-a1")
    expect(left).toHaveTextContent("ch. 2")
    expect(left).not.toHaveTextContent("ch. 1")
  })
})

// AQU-1969: a validator's row counts their OWN approvals, under the four rules.
describe("validate assignments", () => {
  const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })

  it("words a validator's own progress and lists validators after translators, furthest behind first", () => {
    renderSection({
      assignments: [
        // Newest first from the server: the two validators before the translator.
        assignment({
          assignmentId: "v-near",
          username: "bo",
          kind: "validate",
          scopeLabel: "Deuteronomy 11",
          validation: { text: counts(10, 9, 0, 0), audio: counts(10, 0, 10, 0) },
        }),
        assignment({
          assignmentId: "v-far",
          username: "ana",
          kind: "validate",
          scopeLabel: "Deuteronomy 1–10",
          // 34 of 40, 6 left (2 of them changed since), 0 waiting.
          validation: { text: counts(40, 34, 0, 2), audio: counts(40, 0, 40, 0) },
        }),
        assignment({ assignmentId: "t1", username: "tom", kind: "translate" }),
      ],
    })
    const rows = screen.getAllByRole("listitem").map((li) => li.getAttribute("data-testid"))
    expect(rows).toEqual(["plan-assignment-t1", "plan-assignment-v-far", "plan-assignment-v-near"])

    expect(screen.getByTestId("plan-validation-text-v-far").textContent).toBe(
      "Validated 34 of 40 · 6 left · 2 changed since",
    )
    expect(screen.getByTestId("plan-assignment-left-v-far").textContent).toBe("6 left")
    // A validator is labelled as one; a translator is not.
    expect(screen.getByTestId("plan-assignment-v-far").querySelector("[data-testid=plan-assignment-kind]")?.textContent).toBe("Validating")
    expect(screen.getByTestId("plan-assignment-t1").querySelector("[data-testid=plan-assignment-kind]")).toBeNull()
    // No recordings on the file: no audio line.
    expect(screen.queryByTestId("plan-validation-audio-v-far")).toBeNull()
  })

  it("says what is waiting on someone else, and reports recordings when the file has them", () => {
    renderSection({
      showAudio: true,
      assignments: [
        assignment({
          assignmentId: "v1",
          kind: "validate",
          validation: { text: counts(40, 35, 5, 0), audio: counts(40, 3, 36, 1) },
        }),
      ],
    })
    // Five untranslated lines are waiting, not behind: nothing is left in text.
    expect(screen.getByTestId("plan-validation-text-v1").textContent).toBe(
      "Text validated 35 of 40 · waiting on translation (5)",
    )
    expect(screen.getByTestId("plan-validation-audio-v1").textContent).toBe(
      "Audio validated 3 of 40 · 1 left · 1 changed since · waiting on a recording (36)",
    )
    expect(screen.getByTestId("plan-assignment-left-v1").textContent).toBe("1 left")
  })

  it("reads 'Nothing left' once every line ready for them is approved", () => {
    renderSection({
      assignments: [
        assignment({ assignmentId: "v1", kind: "validate", validation: { text: counts(4, 4, 0, 0), audio: counts(4, 0, 4, 0) } }),
      ],
    })
    expect(screen.getByTestId("plan-assignment-left-v1").textContent).toBe("Nothing left")
    expect(screen.getByTestId("plan-validation-text-v1").textContent).toBe("Validated 4 of 4")
  })
})

// AQU-1969 (Sam, 2026-10-19): unassigning is one click wherever work is
// assigned — the org workload's × on every row here too.
describe("one-click unassign", () => {
  const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })
  const rows = () => [
    assignment({ assignmentId: "t1", username: "tom", kind: "translate" }),
    assignment({
      assignmentId: "v1",
      username: "carol",
      kind: "validate",
      validation: { text: counts(7, 2, 2, 0), audio: counts(7, 0, 7, 0) },
    }),
  ]

  it("puts an × on translator and validator rows for whoever may unassign", () => {
    renderSection({ assignments: rows(), onRemove: vi.fn(async () => {}) })
    expect(screen.getByTestId("plan-assignment-remove-t1")).toHaveAccessibleName("Remove assignment: Genesis (tom)")
    expect(screen.getByTestId("plan-assignment-remove-v1")).toHaveAccessibleName("Remove assignment: Genesis (carol)")
  })

  it("has no × for anyone else", () => {
    renderSection({ assignments: rows() })
    expect(screen.queryByTestId("plan-assignment-remove-t1")).toBeNull()
    expect(screen.queryByTestId("plan-assignment-remove-v1")).toBeNull()
  })

  it("one click unassigns that row's assignment and the row goes at once", async () => {
    const onRemove = vi.fn(async () => {})
    renderSection({ assignments: rows(), onRemove })
    fireEvent.click(screen.getByTestId("plan-assignment-remove-v1"))
    expect(onRemove).toHaveBeenCalledWith("v1")
    await screen.findByTestId("plan-assignment-t1")
    await waitFor(() => expect(screen.queryByTestId("plan-assignment-v1")).toBeNull())
    expect(screen.getByTestId("plan-assignment-t1")).toBeInTheDocument()
  })

  it("keeps the row and says why when the server refuses", async () => {
    const onRemove = vi.fn(async () => { throw new Error("role too low for assignment.unassign") })
    renderSection({ assignments: rows(), onRemove })
    fireEvent.click(screen.getByTestId("plan-assignment-remove-t1"))
    expect(await screen.findByText("role too low for assignment.unassign")).toBeInTheDocument()
    expect(screen.getByTestId("plan-assignment-t1")).toBeInTheDocument()
  })
})
