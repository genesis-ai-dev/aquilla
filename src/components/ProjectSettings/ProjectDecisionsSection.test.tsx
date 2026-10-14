// AQU-1691 — the "Project decisions" card.
//
// WHY: every decision listed here binds every later Autopilot draft, so a
// maintainer must be able to see exactly what was decided, where it applies,
// who decided it and when — and correct or remove it. An edit is a new
// decision (it takes the editor's name), a scope the drafting prompt could not
// match is refused rather than stored, and no save may delete a stored entry
// this version cannot read.

import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import { ProjectDecisionsSection, type ProjectDecisionsSectionProps } from "./ProjectDecisionsSection"
import type { ProjectFact } from "../../../db/shared/project-facts"

const kin: ProjectFact = {
  id: "f-kin",
  key: "kin.andrew-peter.relative-age",
  value: "younger",
  scope: { entity: "Andrew" },
  author: "ana",
  at: "2026-10-01T10:00:00.000Z",
  sourceDecisionId: "d-1",
}
const clusivity: ProjectFact = {
  id: "f-we",
  key: "clusivity.ACT.16.10-17",
  value: "exclusive",
  scope: { passage: { from: "ACT 16:10", to: "ACT 16:17" } },
  note: "Luke travels with Paul here.",
  author: "ben",
  at: "2026-10-03T10:00:00.000Z",
}
/** Written by a newer version: this one cannot read it, and must not delete it. */
const unreadable = { id: "f-new", key: "future.fact", shape: "from a later version" }

function renderCard(overrides: Partial<ProjectDecisionsSectionProps> = {}) {
  const props: ProjectDecisionsSectionProps = {
    value: [kin, clusivity, unreadable],
    canEdit: true,
    disabledTooltip: null,
    username: "maintainer-mo",
    patch: vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" })),
    ...overrides,
  }
  renderWithTooltips(<ProjectDecisionsSection {...props} />)
  return props
}

const rows = () => screen.getAllByTestId("project-decision")

describe("ProjectDecisionsSection", () => {
  it("lists each decision with its key, value, scope, author and date, newest first", () => {
    renderCard()
    expect(rows()).toHaveLength(2)
    const [newest, older] = rows()
    expect(newest).toHaveTextContent("clusivity.ACT.16.10-17")
    expect(newest).toHaveTextContent("exclusive")
    expect(newest).toHaveTextContent("ACT 16:10 to ACT 16:17")
    expect(newest).toHaveTextContent(/ben · Oct 3, 2026/)
    expect(newest).toHaveTextContent("Luke travels with Paul here.")
    expect(older).toHaveTextContent("About Andrew")
  })

  it("says what will appear here while there are no decisions", () => {
    renderCard({ value: undefined })
    expect(screen.getByText(/No decisions yet/)).toBeInTheDocument()
  })

  it("saves an edit as the editor's decision, and keeps an entry it cannot read", async () => {
    const props = renderCard()
    fireEvent.click(screen.getByRole("button", { name: "Edit kin.andrew-peter.relative-age" }))
    const editor = screen.getByTestId("project-decision-editor")
    fireEvent.change(within(editor).getByLabelText("Decision"), { target: { value: "older" } })
    fireEvent.change(within(editor).getByLabelText("Book"), { target: { value: "JHN" } })
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(props.patch).toHaveBeenCalledTimes(1))
    const written = vi.mocked(props.patch).mock.calls[0][0].projectFacts as ProjectFact[]
    expect(written).toHaveLength(3)
    expect(written[0]).toMatchObject({
      id: "f-kin",
      key: "kin.andrew-peter.relative-age",
      value: "older",
      scope: { book: "JHN", entity: "Andrew" },
      author: "maintainer-mo",
      sourceDecisionId: "d-1",
    })
    expect(written[2]).toEqual(unreadable)
    expect(await screen.findByText("Decision saved.")).toBeInTheDocument()
  })

  it("refuses a scope the drafting prompt could not match", () => {
    const props = renderCard()
    fireEvent.click(screen.getByRole("button", { name: "Edit kin.andrew-peter.relative-age" }))
    fireEvent.change(screen.getByLabelText("Book"), { target: { value: "Acts" } })
    fireEvent.click(within(screen.getByTestId("project-decision-editor")).getByRole("button", { name: "Save" }))
    expect(props.patch).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/Check the book code/)
  })

  it("removes a decision after a confirmation, keeping the rest", async () => {
    const props = renderCard()
    fireEvent.click(screen.getByRole("button", { name: "Remove clusivity.ACT.16.10-17" }))
    expect(screen.getByText(/Autopilot stops following it/)).toBeInTheDocument()
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(props.patch).toHaveBeenCalledWith({ projectFacts: [kin, unreadable] }))
  })

  it("shows why a save failed", async () => {
    renderCard({ patch: vi.fn(async (): Promise<PatchOutcome> => ({ kind: "blocked", reason: "role" })) })
    fireEvent.click(screen.getByRole("button", { name: "Remove clusivity.ACT.16.10-17" }))
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Remove" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Only a maintainer can change project decisions.")
  })

  it("lets only a maintainer edit or remove", () => {
    renderCard({ canEdit: false })
    expect(screen.getByRole("button", { name: "Edit kin.andrew-peter.relative-age" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Remove clusivity.ACT.16.10-17" })).toBeDisabled()
  })
})
