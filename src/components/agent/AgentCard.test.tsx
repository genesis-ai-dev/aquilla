/**
 * AgentCard tests — the card is the app's transparency surface for the agent
 * team, so the pins are about disclosure rather than layout:
 *
 *   - the avatar is a real, named control (keyboard-reachable, announced as
 *     "About <teammate>") and opens the card on click;
 *   - the card names the teammate's actual tools and the standing project
 *     state it reads;
 *   - the reads link INTO those surfaces under the current project, which is
 *     what makes "it reads your brief" checkable instead of merely claimed —
 *     and degrade to plain text when there is no project to link to, since a
 *     dead link would be a worse answer than none;
 *   - the writes line keeps the approval gate legible: staged, awaiting a
 *     human. That sentence is the one thing a user must not misread.
 */

import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AgentCard, AgentCardTrigger } from "./AgentCard"

const PROJECT_ID = "proj-1"

function renderTrigger(projectId: string | undefined = PROJECT_ID) {
  return render(
    <MemoryRouter>
      <AgentCardTrigger personaId="drafter" projectId={projectId} />
    </MemoryRouter>,
  )
}

function renderCard(personaId: "drafter" | "reviewer" | "coordinator", projectId?: string) {
  return render(
    <MemoryRouter>
      <AgentCard personaId={personaId} projectId={projectId} />
    </MemoryRouter>,
  )
}

describe("AgentCardTrigger", () => {
  it("wraps the avatar in a button named for the teammate", () => {
    renderTrigger()
    const trigger = screen.getByRole("button", { name: "About Drafter" })
    // The persona's own avatar, not a generic info affordance — the roster
    // face and the way into its card are the same object.
    expect(trigger.querySelector('[data-persona="drafter"]')).not.toBeNull()
  })

  it("opens the card on click", () => {
    renderTrigger()
    expect(screen.queryByText("What it can change")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "About Drafter" }))

    expect(screen.getByText("What it can do")).toBeInTheDocument()
    expect(screen.getByText("What it reads")).toBeInTheDocument()
    expect(screen.getByText("What it can change")).toBeInTheDocument()
  })
})

describe("AgentCard", () => {
  it("lists the Drafter's real tools and the state it reads", () => {
    renderCard("drafter", PROJECT_ID)

    for (const tool of [
      "Read the passage",
      "Gather examples",
      "Search the project",
      "Draft a translation",
      "Consult the project documents",
      "Look up Bible resources",
    ]) {
      expect(screen.getByText(tool)).toBeInTheDocument()
    }

    for (const read of ["Translation brief", "Style guide", "Terminology", "Living memory"]) {
      expect(screen.getByText(read)).toBeInTheDocument()
    }
  })

  it("lists the Reviewer's verification passes, not chat tools", () => {
    renderCard("reviewer", PROJECT_ID)
    for (const pass of [
      "Force check",
      "Ambiguity check",
      "Naturalness check",
      "Project rules check",
    ]) {
      expect(screen.getByText(pass)).toBeInTheDocument()
    }
    // The Reviewer does not draft or stage; showing a drafting tool here would
    // misattribute what it is allowed to do.
    expect(screen.queryByText("Draft a translation")).toBeNull()
  })

  it("links each read to its real surface under the current project", () => {
    renderCard("drafter", PROJECT_ID)
    const expected: Record<string, string> = {
      "Translation brief": `/project/${PROJECT_ID}/memory/brief`,
      "Style guide": `/project/${PROJECT_ID}/memory/instructions`,
      Terminology: `/project/${PROJECT_ID}/terminology`,
      "Living memory": `/project/${PROJECT_ID}/memory`,
    }
    for (const [label, href] of Object.entries(expected)) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href)
    }
  })

  it("names the read surfaces as plain text when no project is in scope", () => {
    // The first-run guide can render before a project is in scope; the card
    // still discloses what is read, it just cannot offer a route to it.
    renderCard("drafter", undefined)
    expect(screen.getByText("Translation brief")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Translation brief" })).toBeNull()
  })

  it("states that writes are staged and wait for a human decision", () => {
    for (const personaId of ["drafter", "reviewer", "coordinator"] as const) {
      const view = renderCard(personaId, PROJECT_ID)
      const card = view.container.querySelector(`[data-persona-card="${personaId}"]`)
      expect(card).not.toBeNull()

      const writes = within(card as HTMLElement).getByText("What it can change")
      const sentence = writes.parentElement?.textContent ?? ""
      // Pending, never already-applied: the gate must be readable off the card.
      expect(sentence, `${personaId}`).toMatch(/stage[sd]?\b/i)
      expect(sentence, `${personaId}`).toMatch(/approve/i)
      view.unmount()
    }
  })
})
