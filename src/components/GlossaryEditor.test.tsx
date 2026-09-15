import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
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
let projectCellsLoading = false
let projectCellFiles: Array<{ id: string; cells: Array<{
  id: string
  fileId: string
  original: string
  translated: string
  context: string
  group: string
  type: string
  status: string
  validationStatus: string
  activeValidators: string[]
  validationHistory: unknown[]
  history: unknown[]
  threads: unknown[]
}> }> = []
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: ({ enabled }: { enabled?: boolean }) => {
    projectCellsEnabled = Boolean(enabled)
    return { files: projectCellFiles, isLoading: projectCellsLoading, isTruncated: false }
  },
}))

const patchSettings = vi.fn().mockResolvedValue({ kind: "ok" })
// Writes must become term.* events — never a settings-blob PATCH. The blob is
// retired: a PATCHed term is one nothing else (the editor, other users) reads.
const emitTermCreate = vi.fn(async (_input?: unknown) => "e-create")
const emitTermUpdate = vi.fn(async (_input?: unknown) => "e-update")
const emitTermDelete = vi.fn(async (_input?: unknown) => "e-delete")
const emitTermApprove = vi.fn(async (_input?: unknown) => "e-approve")
const emitTermReject = vi.fn(async (_input?: unknown) => "e-reject")
vi.mock("@/lib/sync/events-emit", () => ({
  emitTermCreate: (input: unknown) => emitTermCreate(input),
  emitTermUpdate: (input: unknown) => emitTermUpdate(input),
  emitTermDelete: (input: unknown) => emitTermDelete(input),
  emitTermApprove: (input: unknown) => emitTermApprove(input),
  emitTermReject: (input: unknown) => emitTermReject(input),
}))
let mockProject: ProjectRecord
let mockProjectLoading = false
// AQU-1006 follow-up: concepts come from the sync-worker projection via
// useConcepts, not from `project.terminology`. These tests keep seeding
// `mockProject.terminology` as their fixture and this mock feeds that same
// array through the new hook, so each test's INTENT is unchanged — only the
// transport moved.
vi.mock("@/hooks/useConcepts", () => ({
  useConcepts: vi.fn(() => ({
    concepts: mockProject?.terminology ?? [],
    isLoading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  })),
}))

vi.mock("@/hooks/useProject", () => ({
  useProject: vi.fn(() => ({
    project: mockProject,
    loading: mockProjectLoading,
    patchSettings,
  })),
}))

import { GlossaryEditor } from "./GlossaryEditor"
import { useProject } from "@/hooks/useProject"

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
  for (const m of [emitTermCreate, emitTermUpdate, emitTermDelete, emitTermApprove, emitTermReject]) m.mockClear()
  projectCellsEnabled = false
  projectCellsLoading = false
  projectCellFiles = []
  mockProjectLoading = false
  mockProject = {
    id: "p1",
    name: "P",
    terminology: [concept({})],
  } as unknown as ProjectRecord
})

function renderEditor(
  props: React.ComponentProps<typeof GlossaryEditor> = {},
  initialEntry = "/project/p1/terminology",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <GlossaryEditor {...props} />
    </MemoryRouter>,
  )
}

describe("GlossaryEditor", () => {
  it("shows explicit progress over a value-free panel while the glossary loads", () => {
    mockProjectLoading = true
    renderEditor()

    const status = screen.getByRole("status", { name: "Loading terminology" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
    expect(screen.getByTestId("loading-panel-template")).toBeInTheDocument()
    expect(screen.queryByText("grace")).not.toBeInTheDocument()
  })

  it("renders active concepts as rows", () => {
    renderEditor()
    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.getByText("favor")).toBeInTheDocument()
  })

  it("opens the concept named by the terminology deep link", async () => {
    renderEditor({}, "/project/p1/terminology?concept=c1")

    expect(
      await screen.findByRole("button", { name: /close detail/i }),
    ).toBeInTheDocument()
    expect(screen.getByText("grace")).toBeInTheDocument()
  })

  it("renders the workspace-owned glossary immediately without a duplicate project resolve", () => {
    mockProjectLoading = true
    const workspaceProject = {
      ...mockProject,
      terminology: [concept({ sourceTerm: "workspace-term" })],
    } as ProjectRecord

    renderEditor({ project: workspaceProject, patchSettings })

    expect(screen.getByText("workspace-term")).toBeInTheDocument()
    expect(screen.queryByRole("status", { name: "Loading terminology" })).not.toBeInTheDocument()
    expect(vi.mocked(useProject)).toHaveBeenLastCalledWith("p1", expect.objectContaining({
      enabled: false,
      includeSettings: false,
    }))
  })

  it("hides archived concepts until 'Show archived' is toggled", () => {
    mockProject.terminology = [concept({ id: "z", sourceTerm: "wrath", status: "deprecated" })]
    renderEditor()
    expect(screen.queryByText("wrath")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /show archived/i }))
    expect(screen.getByText("wrath")).toBeInTheDocument()
  })

  it("archiving an active concept emits term.reject(deprecate), never a settings PATCH", async () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: /archive term/i }))
    await waitFor(() => expect(emitTermReject).toHaveBeenCalled())
    expect(emitTermReject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", conceptId: "c1", mode: "deprecate", author: "tester" }),
    )
    expect(patchSettings).not.toHaveBeenCalled()
  })

  it("adding a term via the create dialog emits term.create for an active concept", async () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    const dialog = screen.getByRole("dialog")
    fireEvent.change(within(dialog).getByPlaceholderText(/new source term/i), {
      target: { value: "mercy" },
    })
    fireEvent.change(within(dialog).getByPlaceholderText(/rendering/i), {
      target: { value: "misericordia" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: /add term/i }))
    await waitFor(() => expect(emitTermCreate).toHaveBeenCalled())
    expect(emitTermCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        sourceTerm: "mercy",
        status: "active",
        renderings: [{ rendering: "misericordia", status: "preferred" }],
        author: "tester",
      }),
    )
    // The optimistic row shows before the flush lands.
    expect(screen.getByText("mercy")).toBeInTheDocument()
    expect(patchSettings).not.toHaveBeenCalled()
  })

  it("requires both a source and rendering before adding an active term", () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    const dialog = screen.getByRole("dialog")
    const add = within(dialog).getByRole("button", { name: /add term/i })
    expect(add).toBeDisabled()
    fireEvent.change(within(dialog).getByPlaceholderText(/new source term/i), {
      target: { value: "mercy" },
    })
    expect(add).toBeDisabled()
    fireEvent.change(within(dialog).getByPlaceholderText(/^rendering$/i), {
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

  it("opens a concept immediately while examples still load", () => {
    mockProject.files = [{ id: "f1", name: "sample.md", type: "md", createdAt: "", cellCount: 1 }]
    projectCellsLoading = true
    renderEditor()

    fireEvent.click(screen.getByRole("button", { name: /open details for grace/i }))

    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.getAllByText("favor").length).toBeGreaterThan(0)
    expect(screen.queryByRole("status", { name: "Loading term details" })).not.toBeInTheDocument()
    expect(screen.getByText(/loading examples/i)).toBeInTheDocument()
  })

  it("derives rapid rendering mutations from the latest optimistic glossary", async () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Expand renderings" }))
    fireEvent.click(screen.getByRole("button", { name: "Add rendering" }))

    const second = await screen.findByRole("textbox", { name: "Rendering 2 text" })
    fireEvent.change(second, { target: { value: "alternate" } })
    fireEvent.blur(second)
    fireEvent.click(screen.getByRole("button", { name: "Remove rendering 1" }))

    await waitFor(() => expect(emitTermUpdate).toHaveBeenCalledTimes(3))
    const last = emitTermUpdate.mock.calls.at(-1)?.[0] as unknown as { renderings: Concept["renderings"] }
    expect(last.renderings).toEqual([
      { rendering: "alternate", status: "admitted" },
    ])
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Rendering 1 text" })).toHaveValue("alternate")
    })
    expect(screen.queryByRole("textbox", { name: "Rendering 2 text" })).not.toBeInTheDocument()
  })
})
