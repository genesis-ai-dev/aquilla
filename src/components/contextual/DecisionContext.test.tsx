// DecisionContext. WHY: "Needs your expertise" questions were unanswerable
// because a reader could not tell where they applied (2026-10-01). The card
// must name the file and passage up front, link into the editor, and expand to
// the verses — and their neighbours — on request.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { DecisionContext } from "./DecisionContext"

const loadPlace = vi.hoisted(() => vi.fn())
const loadAround = vi.hoisted(() => vi.fn())
vi.mock("@/lib/contextual/decision-context", () => ({
  loadDecisionPlace: loadPlace,
  loadDecisionSurroundings: loadAround,
}))

const verse = (cellId: string, ref: string, affected: boolean) => ({
  cellId, ref, source: `source ${ref}`, target: affected ? `target ${ref}` : "", affected,
})

function renderContext() {
  return render(
    <MemoryRouter>
      <DecisionContext projectId="p1" fileId="f1" cellIds={["c3"]} />
    </MemoryRouter>,
  )
}

describe("DecisionContext", () => {
  beforeEach(() => {
    loadPlace.mockReset()
    loadAround.mockReset()
    loadPlace.mockResolvedValue({
      fileName: "Mark",
      passage: "MRK 4:3",
      cells: [verse("c3", "MRK 4:3", true)],
    })
  })

  it("names the file and passage and links into the editor at the cell", async () => {
    renderContext()
    expect(await screen.findByText("Mark · MRK 4:3")).toBeInTheDocument()
    const link = screen.getByRole("link", { name: /Open in editor/ })
    expect(link.getAttribute("href")).toContain("/project/p1/editor/file/f1?cellId=c3")
  })

  it("expands to the affected verse, then to its neighbours on request", async () => {
    loadAround.mockResolvedValue([
      verse("c2", "MRK 4:2", false),
      verse("c3", "MRK 4:3", true),
      verse("c4", "MRK 4:4", false),
    ])
    renderContext()
    await userEvent.click(await screen.findByRole("button", { name: "Show 1 verse" }))
    expect(screen.getByText("source MRK 4:3")).toBeInTheDocument()
    expect(screen.getByText("target MRK 4:3")).toBeInTheDocument()
    expect(loadAround).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Show surrounding verses" }))
    expect(await screen.findByText("source MRK 4:2")).toBeInTheDocument()
    expect(screen.getByText("source MRK 4:4")).toBeInTheDocument()
    expect(screen.getAllByText("Not translated yet")).toHaveLength(2)
    expect(loadAround).toHaveBeenCalledWith("p1", { fileId: "f1", cellIds: ["c3"] })
  })

  it("says so when the place cannot be loaded, and still offers the editor", async () => {
    loadPlace.mockRejectedValue(new Error("offline"))
    renderContext()
    expect(await screen.findByText("Couldn't load where this applies.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Open in editor/ })).toBeInTheDocument()
  })
})
