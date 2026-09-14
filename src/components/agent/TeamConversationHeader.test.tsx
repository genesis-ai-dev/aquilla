import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { TeamConversationHeader, type TeamConversationHeaderProps } from "./TeamConversationHeader"

function runRecord(overrides: Partial<ContextualRunRecord> = {}): ContextualRunRecord {
  return {
    runId: "run-1",
    fileId: "file-1",
    status: "parked",
    phase: null,
    spanLabel: null,
    done: 2,
    total: 2,
    failed: 0,
    unitsSpent: 2,
    callsSpent: 5,
    proposedDrafts: 3,
    targetLang: "",
    activeDirections: [],
    lastError: null,
    createdAt: "2026-08-28T11:00:00Z",
    updatedAt: "2026-08-28T12:00:00Z",
    ...overrides,
  }
}

function header(props: Partial<TeamConversationHeaderProps> = {}) {
  return (
    <MemoryRouter initialEntries={["/project/p1/agent"]}>
      <TeamConversationHeader
        title="Mark"
        projectId="p1"
        activePersonas={new Set()}
        run={runRecord()}
        {...props}
      />
    </MemoryRouter>
  )
}

describe("TeamConversationHeader attention", () => {
  it.each(["", "fr-CA"])("links pending drafts to their existing review lane (%s)", (targetLang) => {
    render(header({ run: runRecord({ targetLang }) }))
    const title = screen.getByRole("heading", { name: "Mark" })
    expect(title).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("3 drafts ready for your review")
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true")
    expect(screen.getByRole("link", { name: "Review drafts" })).toHaveAttribute(
      "href", `/project/p1/editor/file/file-1?lane=${encodeURIComponent(targetLang)}`,
    )
    expect(screen.getByRole("link", { name: "Review drafts" })).toHaveClass("bg-primary")
    expect(screen.getByText("Idle")).toBeInTheDocument()
  })

  it.each([0, undefined])("does not invent pending work for a zero or missing count (%s)", (proposedDrafts) => {
    render(header({ run: runRecord({ proposedDrafts }) }))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Review drafts" })).not.toBeInTheDocument()
    expect(screen.getByText("Idle")).toBeInTheDocument()
  })

  it("updates the pending count and removes the action when the run has no proposals left", () => {
    const view = render(header())
    view.rerender(header({ run: runRecord({ proposedDrafts: 1 }) }))
    expect(screen.getByRole("status")).toHaveTextContent("1 draft ready for your review")

    view.rerender(header({ run: runRecord({ proposedDrafts: 0 }) }))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Review drafts" })).not.toBeInTheDocument()
  })

  it("shows the full open-question count with a link to the existing questions conversation", () => {
    render(header({
      run: null,
      title: "Team chat",
      openQuestionCount: 7,
      questionsHref: "?conversation=questions&lane=fr",
    }))
    expect(screen.getByRole("status")).toHaveTextContent("7 questions need your expertise")
    expect(screen.getByRole("link", { name: "View questions" })).toHaveAttribute(
      "href", "/project/p1/agent?conversation=questions&lane=fr",
    )
  })

  it("keeps question answers in their cards rather than adding an action in the questions header", () => {
    render(header({ run: null, title: "Needs your expertise", openQuestionCount: 1 }))
    expect(screen.getByRole("status")).toHaveTextContent("1 question needs your expertise")
    expect(screen.queryByRole("link", { name: "View questions" })).not.toBeInTheDocument()
  })

  it("does not present project-wide questions as work belonging to the selected run", () => {
    render(header({ openQuestionCount: 7, questionsHref: "?conversation=questions" }))
    expect(screen.getByRole("status")).toHaveTextContent("3 drafts ready for your review")
    expect(screen.queryByRole("link", { name: "View questions" })).not.toBeInTheDocument()
  })

  it("leaves an empty Team chat without an attention prompt", () => {
    render(header({ title: "Team chat", run: null }))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    const roster = screen.getByRole("list", { name: "Your translation team" })
    expect(within(roster).getAllByRole("button")).toHaveLength(3)
  })
})
