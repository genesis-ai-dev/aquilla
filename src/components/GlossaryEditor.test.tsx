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

// The drill-down's inline editor is TipTap; the role-gating tests only need to
// know whether it MOUNTED, so a marker keeps that assertion exact.
vi.mock("@/components/TranslatedEditor", () => ({
  TranslatedEditor: () => <div data-testid="inline-cell-editor" />,
}))

import { GlossaryEditor } from "./GlossaryEditor"
import { useProject } from "@/hooks/useProject"
import { minimalProjectRecord } from "@/lib/sync/cloud-projects"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

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

  it("persists a rendering removed from the concept detail view as a term event", async () => {
    // The detail view is where a lead actually reads a term's usage, so the
    // rendering edits it offers have to reach the event log from there — not
    // only from the glossary row's edit dialog.
    mockProject = {
      id: "p1",
      name: "P",
      terminology: [
        concept({
          renderings: [
            { rendering: "favor", status: "preferred" },
            { rendering: "gracia", status: "admitted" },
          ],
        }),
      ],
    } as unknown as ProjectRecord
    renderEditor({}, "/project/p1/terminology?concept=c1")

    fireEvent.click(await screen.findByRole("button", { name: /remove rendering favor/i }))

    await waitFor(() => expect(emitTermUpdate).toHaveBeenCalled())
    expect(emitTermUpdate.mock.calls[0][0]).toMatchObject({
      renderings: [{ rendering: "gracia", status: "admitted" }],
    })
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

// AQU-208: role gating on the LIVE terminology surface.
//
// The fixture is the real output of `minimalProjectRecord` — the shape every
// server-resolved project arrives in, which never carries `origin` — with the
// projection's concepts folded on the way ProjectWorkspace's `editorProject`
// does. Both gates used to read "no origin" as "local project, allow
// everything", so a viewer got Add term, Import, Export and an inline cell
// editor. The hand-built fixture above has no role at all and only ever
// exercised the fail-open path, which is how that shipped.
describe("GlossaryEditor role gating (AQU-208)", () => {
  const TERMBASE_CONTROLS = ["Suggest terms", "Import", "Export CSV", "Export TBX", "Add term"]

  function hydrated(level: number, name: string, termbaseEditMinRole?: number): ProjectRecord {
    return {
      ...minimalProjectRecord({
        id: "p1",
        name: "P",
        gitlabProjectId: null,
        role: { level, name, source: "project" },
        files: [{ id: "f1", name: "GEN.usfm", type: "usfm", cellCount: 1 }],
        ...(termbaseEditMinRole === undefined ? {} : { termbaseEditMinRole }),
      }),
      terminology: [concept({})],
    }
  }

  function renderAs(project: ProjectRecord, initialEntry = "/project/p1/terminology") {
    return renderWithTooltips(
      <MemoryRouter initialEntries={[initialEntry]}>
        <GlossaryEditor project={project} patchSettings={patchSettings} />
      </MemoryRouter>,
    )
  }

  /** One occurrence of "grace" whose target is still empty — the exact cell the
   *  QA walk opened an editor on as a viewer. */
  function seedOccurrence() {
    projectCellFiles = [{
      id: "f1",
      cells: [{
        id: "cell-1",
        fileId: "f1",
        original: "by grace alone",
        translated: "",
        context: "GEN 1:8",
        group: "GEN 1",
        type: "text",
        status: "unvalidated",
        validationStatus: "none",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
      }],
    }]
  }

  it("hydrated records carry a role and no origin (the shape that escaped)", () => {
    const record = hydrated(100, "viewer")
    expect(record.origin).toBeUndefined()
    expect(record.syncRole?.level).toBe(100)
  })

  it.each([
    [100, "viewer", /Viewers cannot perform this action — you need at least Project lead access/],
    [400, "contributor", /Contributors cannot perform this action — you need at least Project lead access/],
  ])("keeps the termbase controls visible but disabled for level %i, with the role tooltip", async (level, name, tip) => {
    renderAs(hydrated(level, name))

    for (const control of TERMBASE_CONTROLS) {
      expect(screen.getByRole("button", { name: control })).toBeDisabled()
    }
    await expectTooltip(screen.getByRole("button", { name: "Add term" }), tip)

    // Disabled is not merely cosmetic: the create dialog cannot be opened.
    fireEvent.click(screen.getByRole("button", { name: "Add term" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    // The read-only surfaces stay reachable for every role.
    expect(screen.getByRole("button", { name: "Violations" })).toBeEnabled()
    expect(screen.getByText("grace")).toBeInTheDocument()
  })

  it("enables the termbase controls for a project lead", () => {
    renderAs(hydrated(500, "project_lead"))

    for (const control of TERMBASE_CONTROLS) {
      expect(screen.getByRole("button", { name: control })).toBeEnabled()
    }
    fireEvent.click(screen.getByRole("button", { name: "Add term" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("follows an org floor lowered to contributor (AQU-822)", () => {
    renderAs(hydrated(400, "contributor", 400))

    for (const control of TERMBASE_CONTROLS) {
      expect(screen.getByRole("button", { name: control })).toBeEnabled()
    }
  })

  it("names the org's configured floor in the tooltip, not the default", async () => {
    renderAs(hydrated(500, "project_lead", 600))

    await expectTooltip(
      screen.getByRole("button", { name: "Import" }),
      /Project leads cannot perform this action — you need at least Maintainer access/,
    )
  })

  it("keeps the drill-down's target cell read-only for a viewer", async () => {
    seedOccurrence()
    renderAs(hydrated(100, "viewer"), "/project/p1/terminology?concept=c1")

    fireEvent.click(await screen.findByRole("button", { name: "(empty)" }))

    expect(screen.queryByTestId("inline-cell-editor")).not.toBeInTheDocument()
    // …and the rendering controls on the same page stay off too.
    expect(screen.queryByRole("button", { name: /remove rendering favor/i })).not.toBeInTheDocument()
  })

  it("lets a contributor edit the drill-down's target cell but not the renderings", async () => {
    seedOccurrence()
    renderAs(hydrated(400, "contributor"), "/project/p1/terminology?concept=c1")

    fireEvent.click(await screen.findByRole("button", { name: "(empty)" }))

    expect(screen.getByTestId("inline-cell-editor")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /remove rendering favor/i })).not.toBeInTheDocument()
  })
})
