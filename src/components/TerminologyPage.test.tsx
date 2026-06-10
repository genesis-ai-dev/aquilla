import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { TerminologyPage } from "./TerminologyPage"
import type { Concept } from "@/lib/terminology/types"
import type { ProjectRecord } from "@/lib/parsers/types"

// ── Mock the data-layer stubs ─────────────────────────────────────────────
vi.mock("@/lib/terminology/store", () => ({
  addConcept: vi.fn(),
  updateConcept: vi.fn(),
  deleteConcept: vi.fn(),
  mergeConcepts: vi.fn(),
  approveConcept: vi.fn(),
  rejectConcept: vi.fn(),
}))
vi.mock("@/lib/terminology/csv", () => ({
  importConceptsCsv: vi.fn(),
  exportConceptsCsv: vi.fn(),
}))
vi.mock("@/lib/terminology/tbx", () => ({
  importConceptsTbx: vi.fn(),
  exportConceptsTbx: vi.fn(),
}))

// ── Mock hooks that need external providers ───────────────────────────────
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: null, loading: false }),
}))

vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildFileScopedTokenFetcher: () => async (_fileId: string) => null,
}))

vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: () => ({ files: [], isTruncated: false }),
}))

// ── Mock useProject so tests don't need a real session/IDB ───────────────
const mockPatchSettings = vi.fn().mockResolvedValue({ kind: "ok" })
const mockProject: ProjectRecord = {
  id: "test-project-id",
  name: "Test Project",
  terminology: [],
} as unknown as ProjectRecord

vi.mock("@/hooks/useProject", () => ({
  useProject: vi.fn(() => ({
    project: mockProject,
    loading: false,
    status: "ready",
    isError: false,
    isUnreachable: false,
    refresh: vi.fn(),
    patchSettings: mockPatchSettings,
  })),
}))

import { addConcept, deleteConcept, approveConcept, rejectConcept, mergeConcepts } from "@/lib/terminology/store"
import { importConceptsCsv } from "@/lib/terminology/csv"
import { useProject } from "@/hooks/useProject"

// Helper: render with a router so useParams / useNavigate work
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/project/test-project-id/terminology"]}>
      <TerminologyPage />
    </MemoryRouter>,
  )
}

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "c1",
    sourceTerm: "πνεῦμα",
    renderings: [
      { rendering: "spirit", status: "preferred" },
      { rendering: "wind", status: "admitted" },
      { rendering: "ghost", status: "forbidden" },
    ],
    notes: "Common theological term",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function makeProjectWithConcepts(concepts: Concept[]): ProjectRecord {
  return { ...mockProject, terminology: concepts } as unknown as ProjectRecord
}

/**
 * Open the Add concept dialog and fill in required fields.
 * Returns `within(dialog)` scoped queries.
 */
async function fillAndSubmitAddDialog(sourceTerm: string, renderingText: string) {
  // Header "Add concept" button
  fireEvent.click(screen.getByRole("button", { name: /^Add concept$/ }))
  const dialog = await screen.findByRole("dialog", { hidden: true })
  const q = within(dialog)

  // Source term
  fireEvent.change(q.getByLabelText(/Source term/i), {
    target: { value: sourceTerm },
  })

  // Fill in the first (default) rendering input
  const renderingInputs = q.getAllByPlaceholderText("rendering")
  fireEvent.change(renderingInputs[0], { target: { value: renderingText } })

  // Submit — "Add concept" button inside the dialog
  fireEvent.click(q.getByRole("button", { name: /^Add concept$/ }))
}

describe("TerminologyPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset useProject to return an empty project by default
    vi.mocked(useProject).mockReturnValue({
      project: mockProject,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })
    mockPatchSettings.mockResolvedValue({ kind: "ok" })
  })

  // ── Empty state ────────────────────────────────────────────────────────────

  it("renders empty state when no concepts exist", () => {
    renderPage()
    expect(screen.getByText(/No concepts yet/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Add first concept/i })).toBeInTheDocument()
  })

  it("renders page header with correct title", () => {
    renderPage()
    expect(screen.getByRole("heading", { name: /Terminology/i })).toBeInTheDocument()
  })

  // ── Export buttons disabled when empty ───────────────────────────────────

  it("export buttons are disabled when no concepts exist", () => {
    renderPage()
    const csvBtn = screen.getByRole("button", { name: /Export CSV/i })
    const tbxBtn = screen.getByRole("button", { name: /Export TBX/i })
    expect(csvBtn).toBeDisabled()
    expect(tbxBtn).toBeDisabled()
  })

  // ── Concept add via dialog ─────────────────────────────────────────────────
  // base-ui Dialog marks the rest of the page aria-hidden when open.
  // We use within(dialog) to scope queries after the portal renders.

  it("renders concepts returned from addConcept via the dialog", async () => {
    const saved = makeConcept()
    const updatedProject = makeProjectWithConcepts([saved])
    vi.mocked(addConcept).mockReturnValueOnce(updatedProject)

    // After patchSettings resolves, make useProject return the updated project
    mockPatchSettings.mockImplementationOnce(async () => {
      vi.mocked(useProject).mockReturnValue({
        project: updatedProject,
        loading: false,
        status: "ready",
        isError: false,
        isUnreachable: false,
        refresh: vi.fn(),
        patchSettings: mockPatchSettings,
      })
      return { kind: "ok" }
    })

    renderPage()
    await fillAndSubmitAddDialog("πνεῦμα", "spirit")

    await waitFor(() => {
      expect(addConcept).toHaveBeenCalledWith(
        expect.objectContaining({ id: "test-project-id" }),
        expect.objectContaining({ sourceTerm: "πνεῦμα" }),
      )
    })

    // patchSettings should have been called with the updated terminology
    await waitFor(() => {
      expect(mockPatchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ terminology: [saved] }),
      )
    })
  })

  // ── Delete ─────────────────────────────────────────────────────────────────

  it("removes a concept after delete is called and resolves", async () => {
    const existing = makeConcept()
    const projectWithConcept = makeProjectWithConcepts([existing])
    const projectAfterDelete = makeProjectWithConcepts([])

    // Start with a project that already has the concept
    vi.mocked(useProject).mockReturnValue({
      project: projectWithConcept,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })

    vi.mocked(deleteConcept).mockReturnValueOnce(projectAfterDelete)
    mockPatchSettings.mockImplementationOnce(async () => {
      vi.mocked(useProject).mockReturnValue({
        project: projectAfterDelete,
        loading: false,
        status: "ready",
        isError: false,
        isUnreachable: false,
        refresh: vi.fn(),
        patchSettings: mockPatchSettings,
      })
      return { kind: "ok" }
    })

    renderPage()

    await waitFor(() => expect(screen.getByTestId("concept-row")).toBeInTheDocument())

    // Delete
    fireEvent.click(screen.getByRole("button", { name: /Delete concept πνεῦμα/i }))

    await waitFor(() => {
      expect(deleteConcept).toHaveBeenCalledWith(
        expect.objectContaining({ id: "test-project-id" }),
        "c1",
      )
    })
  })

  // ── CSV import ─────────────────────────────────────────────────────────────

  it("calls importConceptsCsv on file upload and shows new concepts", async () => {
    const imported = makeConcept({ id: "imported-1", sourceTerm: "λόγος" })
    const updatedProject = makeProjectWithConcepts([imported])
    vi.mocked(importConceptsCsv).mockReturnValueOnce([imported])
    mockPatchSettings.mockImplementationOnce(async () => {
      vi.mocked(useProject).mockReturnValue({
        project: updatedProject,
        loading: false,
        status: "ready",
        isError: false,
        isUnreachable: false,
        refresh: vi.fn(),
        patchSettings: mockPatchSettings,
      })
      return { kind: "ok" }
    })

    renderPage()

    // Open import dialog
    fireEvent.click(screen.getByRole("button", { name: /^Import$/ }))
    const dialog = await screen.findByRole("dialog", { hidden: true })

    // Find file input inside the dialog
    const input = dialog.querySelector("input[type='file']") as HTMLInputElement
    expect(input).toBeTruthy()

    // Simulate file selection
    const csvContent = "source_lemma,target_lemma,target_status\nλόγος,word,preferred"
    const file = new File([csvContent], "termbase.csv", { type: "text/csv" })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(importConceptsCsv).toHaveBeenCalled()
    })

    // patchSettings should have been called with the imported concept
    await waitFor(() => {
      expect(mockPatchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ terminology: expect.arrayContaining([imported]) }),
      )
    })
  })

  // ── Review queue ───────────────────────────────────────────────────────────

  it("Review queue tab shows draft concepts", async () => {
    const draft = makeConcept({ id: "d1", sourceTerm: "ψυχή", status: "draft" })
    const projectWithDraft = makeProjectWithConcepts([draft])

    vi.mocked(useProject).mockReturnValue({
      project: projectWithDraft,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })

    renderPage()

    // Switch to Queue tab
    fireEvent.click(screen.getByRole("button", { name: /Review queue/i }))

    // The queue row should be visible
    await waitFor(() => {
      expect(screen.getByTestId("queue-row")).toBeInTheDocument()
    })
    expect(screen.getByText("ψυχή")).toBeInTheDocument()
  })

  it("Approve action calls approveConcept and persists", async () => {
    const draft = makeConcept({ id: "d1", sourceTerm: "ψυχή", status: "draft" })
    const projectWithDraft = makeProjectWithConcepts([draft])
    const projectAfterApprove = makeProjectWithConcepts([
      { ...draft, status: "active" },
    ])

    vi.mocked(useProject).mockReturnValue({
      project: projectWithDraft,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })

    vi.mocked(approveConcept).mockReturnValueOnce(projectAfterApprove)
    mockPatchSettings.mockImplementationOnce(async () => {
      vi.mocked(useProject).mockReturnValue({
        project: projectAfterApprove,
        loading: false,
        status: "ready",
        isError: false,
        isUnreachable: false,
        refresh: vi.fn(),
        patchSettings: mockPatchSettings,
      })
      return { kind: "ok" }
    })

    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /Review queue/i }))

    await waitFor(() => expect(screen.getByTestId("queue-row")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /Approve concept ψυχή/i }))

    await waitFor(() => {
      expect(approveConcept).toHaveBeenCalledWith(
        expect.objectContaining({ id: "test-project-id" }),
        "d1",
      )
    })

    await waitFor(() => {
      expect(mockPatchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          terminology: expect.arrayContaining([
            expect.objectContaining({ status: "active" }),
          ]),
        }),
      )
    })
  })

  it("Reject action calls rejectConcept and persists", async () => {
    const draft = makeConcept({ id: "d1", sourceTerm: "ψυχή", status: "draft" })
    const projectWithDraft = makeProjectWithConcepts([draft])
    const projectAfterReject = makeProjectWithConcepts([])

    vi.mocked(useProject).mockReturnValue({
      project: projectWithDraft,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })

    vi.mocked(rejectConcept).mockReturnValueOnce(projectAfterReject)
    mockPatchSettings.mockImplementationOnce(async () => {
      vi.mocked(useProject).mockReturnValue({
        project: projectAfterReject,
        loading: false,
        status: "ready",
        isError: false,
        isUnreachable: false,
        refresh: vi.fn(),
        patchSettings: mockPatchSettings,
      })
      return { kind: "ok" }
    })

    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /Review queue/i }))

    await waitFor(() => expect(screen.getByTestId("queue-row")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /Reject concept ψυχή/i }))

    await waitFor(() => {
      expect(rejectConcept).toHaveBeenCalledWith(
        expect.objectContaining({ id: "test-project-id" }),
        "d1",
        "delete",
      )
    })
  })

  it("Review queue shows empty state when no drafts exist", async () => {
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /Review queue/i }))
    await waitFor(() => {
      expect(screen.getByTestId("review-queue-empty")).toBeInTheDocument()
    })
  })

  // ── Merge duplicates ────────────────────────────────────────────────────────

  it("Merge duplicates dialog opens when 2+ concepts exist and user can manage", async () => {
    const c1 = makeConcept({ id: "c1", sourceTerm: "spirit" })
    const c2 = makeConcept({ id: "c2", sourceTerm: "breath" })
    const projectWith2 = makeProjectWithConcepts([c1, c2])

    vi.mocked(useProject).mockReturnValue({
      project: projectWith2,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })

    renderPage()

    // Merge duplicates button should be visible
    const mergeBtn = screen.getByTestId("merge-duplicates-btn")
    expect(mergeBtn).toBeInTheDocument()

    fireEvent.click(mergeBtn)

    const dialog = await screen.findByRole("dialog", { hidden: true })
    expect(within(dialog).getByText(/Merge duplicate concepts/i)).toBeInTheDocument()
  })

  it("Merge flow: select 2, preview, confirm calls mergeConcepts and persists", async () => {
    const c1 = makeConcept({ id: "c1", sourceTerm: "spirit" })
    const c2 = makeConcept({ id: "c2", sourceTerm: "breath" })
    const projectWith2 = makeProjectWithConcepts([c1, c2])
    const projectAfterMerge = makeProjectWithConcepts([c1]) // c2 removed

    vi.mocked(useProject).mockReturnValue({
      project: projectWith2,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })

    vi.mocked(mergeConcepts).mockReturnValueOnce(projectAfterMerge)
    mockPatchSettings.mockImplementationOnce(async () => {
      vi.mocked(useProject).mockReturnValue({
        project: projectAfterMerge,
        loading: false,
        status: "ready",
        isError: false,
        isUnreachable: false,
        refresh: vi.fn(),
        patchSettings: mockPatchSettings,
      })
      return { kind: "ok" }
    })

    renderPage()

    // Open merge dialog
    fireEvent.click(screen.getByTestId("merge-duplicates-btn"))
    const dialog = await screen.findByRole("dialog", { hidden: true })
    const q = within(dialog)

    // Select both concepts (rows are buttons)
    const rows = q.getAllByTestId("merge-concept-row")
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[0]) // select c1 (spirit)
    fireEvent.click(rows[1]) // select c2 (breath)

    // Advance to preview
    fireEvent.click(q.getByRole("button", { name: /Preview merge/i }))

    // Preview should be shown
    await waitFor(() => {
      expect(q.getByTestId("merge-preview")).toBeInTheDocument()
    })

    // Confirm merge
    fireEvent.click(q.getByRole("button", { name: /Confirm merge/i }))

    await waitFor(() => {
      expect(mergeConcepts).toHaveBeenCalledWith(
        expect.objectContaining({ id: "test-project-id" }),
        ["c1", "c2"],
        "c1",
      )
    })

    await waitFor(() => {
      expect(mockPatchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ terminology: [c1] }),
      )
    })
  })

  // ── Rendering chips ────────────────────────────────────────────────────────

  it("shows rendering chips with correct status labels for existing concepts", () => {
    const existing = makeConcept()
    const projectWithConcept = makeProjectWithConcepts([existing])

    vi.mocked(useProject).mockReturnValue({
      project: projectWithConcept,
      loading: false,
      status: "ready",
      isError: false,
      isUnreachable: false,
      refresh: vi.fn(),
      patchSettings: mockPatchSettings,
    })

    renderPage()

    // The makeConcept has preferred/admitted/forbidden renderings
    // Check their status label chips (format is "rendering·statusLabel")
    expect(screen.getByText(/·required/i)).toBeInTheDocument()
    expect(screen.getByText(/·alternate/i)).toBeInTheDocument()
    expect(screen.getByText(/·forbidden/i)).toBeInTheDocument()
  })
})
