import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { Concept } from "@/lib/terminology/types"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useParams: () => ({ id: "p1" }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "tester" }, loading: false }),
}))
let projectCellsEnabled = false
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: ({ enabled }: { enabled?: boolean }) => {
    projectCellsEnabled = Boolean(enabled)
    return { files: [], isLoading: false, isTruncated: false }
  },
}))

const patchSettings = vi.fn().mockResolvedValue({ kind: "ok" })
let mockProject: ProjectRecord
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: mockProject, loading: false, patchSettings }),
}))

import { GlossaryEditor } from "./GlossaryEditor"

function concept(p: Partial<Concept>): Concept {
  return {
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "favor", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  }
}

beforeEach(() => {
  patchSettings.mockClear()
  projectCellsEnabled = false
  mockProject = {
    id: "p1",
    name: "P",
    terminology: [concept({})],
  } as unknown as ProjectRecord
})

function renderEditor() {
  return render(
    <MemoryRouter>
      <GlossaryEditor />
    </MemoryRouter>,
  )
}

describe("GlossaryEditor", () => {
  it("renders active concepts as rows", () => {
    renderEditor()
    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.getByText("favor")).toBeInTheDocument()
  })

  it("hides archived concepts until 'Show archived' is toggled", () => {
    mockProject.terminology = [concept({ id: "z", sourceTerm: "wrath", status: "deprecated" })]
    renderEditor()
    expect(screen.queryByText("wrath")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /show archived/i }))
    expect(screen.getByText("wrath")).toBeInTheDocument()
  })

  it("archiving an active concept persists status=deprecated", async () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: /archive term/i }))
    await waitFor(() => expect(patchSettings).toHaveBeenCalled())
    const arg = patchSettings.mock.calls[0][0] as { terminology: Concept[] }
    expect(arg.terminology[0].status).toBe("deprecated")
  })

  it("adding a term via the append row persists a new active concept", async () => {
    renderEditor()
    fireEvent.change(screen.getByPlaceholderText(/new source term/i), {
      target: { value: "mercy" },
    })
    fireEvent.change(screen.getByPlaceholderText(/rendering/i), {
      target: { value: "misericordia" },
    })
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => expect(patchSettings).toHaveBeenCalled())
    const arg = patchSettings.mock.calls[0][0] as { terminology: Concept[] }
    const added = arg.terminology.find((c) => c.sourceTerm === "mercy")
    expect(added?.status).toBe("active")
    expect(added?.renderings).toEqual([{ rendering: "misericordia", status: "preferred" }])
  })

  it("requires both a source and rendering before adding an active term", () => {
    renderEditor()
    const add = screen.getByRole("button", { name: /add term/i })
    expect(add).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/new source term/i), {
      target: { value: "mercy" },
    })
    expect(add).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/^rendering$/i), {
      target: { value: "misericordia" },
    })
    expect(add).toBeEnabled()
  })

  it("defers project cell loading until a cell-backed surface is requested", () => {
    mockProject.files = [{ id: "f1", name: "sample.md", type: "md", createdAt: "", cellCount: 1 }]
    renderEditor()
    expect(projectCellsEnabled).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Violations" }))
    expect(projectCellsEnabled).toBe(true)
  })

  it("derives rapid rendering mutations from the latest optimistic glossary", async () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Expand renderings" }))
    fireEvent.click(screen.getByRole("button", { name: "Add rendering" }))

    const second = await screen.findByRole("textbox", { name: "Rendering 2 text" })
    fireEvent.change(second, { target: { value: "alternate" } })
    fireEvent.blur(second)
    fireEvent.click(screen.getByRole("button", { name: "Remove rendering 1" }))

    await waitFor(() => expect(patchSettings).toHaveBeenCalledTimes(3))
    const last = patchSettings.mock.calls.at(-1)?.[0] as { terminology: Concept[] }
    expect(last.terminology[0].renderings).toEqual([
      { rendering: "alternate", status: "admitted" },
    ])
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Rendering 1 text" })).toHaveValue("alternate")
    })
    expect(screen.queryByRole("textbox", { name: "Rendering 2 text" })).not.toBeInTheDocument()
  })
})
