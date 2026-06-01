import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { TerminologyPage } from "./TerminologyPage"
import type { Concept } from "@/lib/terminology/types"

// ── Mock the data-layer stubs ─────────────────────────────────────────────
vi.mock("@/lib/terminology/store", () => ({
  addConcept: vi.fn(),
  updateConcept: vi.fn(),
  deleteConcept: vi.fn(),
}))
vi.mock("@/lib/terminology/csv", () => ({
  importConceptsCsv: vi.fn(),
  exportConceptsCsv: vi.fn(),
}))
vi.mock("@/lib/terminology/tbx", () => ({
  importConceptsTbx: vi.fn(),
  exportConceptsTbx: vi.fn(),
}))

import { addConcept, deleteConcept } from "@/lib/terminology/store"
import { importConceptsCsv } from "@/lib/terminology/csv"

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
    vi.mocked(addConcept).mockResolvedValueOnce(saved)

    renderPage()
    await fillAndSubmitAddDialog("πνεῦμα", "spirit")

    await waitFor(() => {
      expect(addConcept).toHaveBeenCalledWith(
        expect.objectContaining({ sourceTerm: "πνεῦμα" }),
      )
    })

    // After dialog closes, concept row should be visible
    await waitFor(() => {
      expect(screen.getByTestId("concept-row")).toBeInTheDocument()
    })
    expect(screen.getByText("πνεῦμα")).toBeInTheDocument()
  })

  // ── Delete ─────────────────────────────────────────────────────────────────

  it("removes a concept after delete is called and resolves", async () => {
    const saved = makeConcept()
    vi.mocked(addConcept).mockResolvedValueOnce(saved)
    vi.mocked(deleteConcept).mockResolvedValueOnce(undefined)

    renderPage()
    await fillAndSubmitAddDialog("πνεῦμα", "spirit")

    await waitFor(() => expect(screen.getByTestId("concept-row")).toBeInTheDocument())

    // Delete
    fireEvent.click(screen.getByRole("button", { name: /Delete concept πνεῦμα/i }))

    await waitFor(() => {
      expect(deleteConcept).toHaveBeenCalledWith("c1")
    })

    expect(screen.queryByTestId("concept-row")).not.toBeInTheDocument()
  })

  // ── CSV import ─────────────────────────────────────────────────────────────

  it("calls importConceptsCsv on file upload and shows new concepts", async () => {
    const imported = makeConcept({ id: "imported-1", sourceTerm: "λόγος" })
    vi.mocked(importConceptsCsv).mockReturnValueOnce([imported])

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

    // Dialog should close and new concept should be visible
    await waitFor(() => {
      expect(screen.getByTestId("concept-row")).toBeInTheDocument()
    })
    expect(screen.getByText("λόγος")).toBeInTheDocument()
  })

  // ── Rendering chips ────────────────────────────────────────────────────────

  it("shows rendering chips with correct status labels after concept is added", async () => {
    const saved = makeConcept()
    vi.mocked(addConcept).mockResolvedValueOnce(saved)

    renderPage()
    await fillAndSubmitAddDialog("πνεῦμα", "spirit")

    await waitFor(() => expect(screen.getByTestId("concept-row")).toBeInTheDocument())

    // The makeConcept has preferred/admitted/forbidden renderings
    // Check their status label chips (format is "rendering·statusLabel")
    expect(screen.getByText(/·required/i)).toBeInTheDocument()
    expect(screen.getByText(/·alternate/i)).toBeInTheDocument()
    expect(screen.getByText(/·avoid/i)).toBeInTheDocument()
  })
})
