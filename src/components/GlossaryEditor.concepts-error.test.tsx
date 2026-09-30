/**
 * AQU-1340 — a FAILED concepts read must not render as an empty termbase.
 *
 * These tests deliberately use the REAL `useConcepts` hook and fail the read at
 * its own producer boundary (`fetchConcepts` rejecting with a real
 * `ConceptsReadError`), per AGENTS.md rules 12/13: the bug was that the hook's
 * `error` — which it sets on purpose, to fail closed — was dropped by every
 * consumer one line later. A hand-built `{ error }` fixture stubbed over the
 * hook would assert the consumer against a shape the producer never proves it
 * emits, which is exactly the seam the regression escaped through.
 *
 * `GlossaryEditor.test.tsx` mocks `useConcepts` (its fixture is the termbase),
 * so this file is separate: the two cannot share a module mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { Concept } from "@/lib/terminology/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { ConceptsReadError } from "@/lib/sync/concepts-read"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useParams: () => ({ id: "p1" }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { username: "tester", jwt: "session-jwt" },
    loading: false,
  }),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: () => ({ files: [], isLoading: false, isTruncated: false }),
}))
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: mockProject,
    loading: false,
    patchSettings: vi.fn().mockResolvedValue({ kind: "ok" }),
  }),
}))
// The real hook calls this to mint the file-scoped token the concepts route
// wants; only `fetchConcepts` below is the failure under test.
vi.mock("@/lib/sync/cqrs-bridge", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/cqrs-bridge")>()),
  buildFileScopedTokenFetcher: () => async () => "file-token",
}))
// The hook re-reads when the outbox flush lands a `term.*` event. Capturing
// the listener (instead of booting the real flusher) gives the tests a real
// re-read trigger without IDB.
let appliedListener: ((frames: Array<{ project: string; kind: string }>) => void) | null = null
vi.mock("@/lib/sync/outbox-flush", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync/outbox-flush")>()),
  subscribeAppliedEvents: (fn: (frames: Array<{ project: string; kind: string }>) => void) => {
    appliedListener = fn
    return () => {
      appliedListener = null
    }
  },
}))

const fetchConcepts = vi.fn<(projectId: string, jwt: string) => Promise<Concept[]>>()
vi.mock("@/lib/sync/concepts-read", async (orig) => {
  const actual = await orig<typeof import("@/lib/sync/concepts-read")>()
  return { ...actual, fetchConcepts: (p: string, j: string) => fetchConcepts(p, j) }
})

import { GlossaryEditor } from "./GlossaryEditor"

let mockProject: ProjectRecord

function concept(p: Partial<Concept> = {}): Concept {
  return {
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "favor", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  }
}

/** The 500 that produced the original report: the route's SELECT naming a
 *  column a pending migration had not added yet. */
function readFailure(): ConceptsReadError {
  return new ConceptsReadError(500, "concepts read failed")
}

beforeEach(() => {
  fetchConcepts.mockReset()
  mockProject = { id: "p1", name: "P" } as unknown as ProjectRecord
})

function renderEditor(props: React.ComponentProps<typeof GlossaryEditor> = {}) {
  return render(
    <MemoryRouter initialEntries={["/project/p1/terminology"]}>
      <GlossaryEditor {...props} />
    </MemoryRouter>,
  )
}

describe("GlossaryEditor — failed concepts read (AQU-1340)", () => {
  it("shows a load-failure state instead of the empty-termbase state", async () => {
    fetchConcepts.mockRejectedValue(readFailure())
    renderEditor()

    const alert = await screen.findByTestId("concepts-read-error")
    expect(alert).toHaveAttribute("role", "alert")
    expect(alert).toHaveTextContent("Couldn’t load terms")
    // The point of the ticket: the user must not be told their terms are gone.
    expect(screen.queryByText(/No terms yet/)).not.toBeInTheDocument()
    // The raw server reason is carried through so the cause is diagnosable.
    expect(alert).toHaveTextContent(/HTTP 500/)
  })

  it("disables every whole-termbase write while the termbase is unknown", async () => {
    fetchConcepts.mockRejectedValue(readFailure())
    renderEditor()
    await screen.findByTestId("concepts-read-error")

    expect(screen.getByRole("button", { name: "Add term" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Import/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Suggest terms/ })).toBeDisabled()
  })

  it("explains the disabled control by naming the failed read", async () => {
    fetchConcepts.mockRejectedValue(readFailure())
    renderWithTooltips(
      <MemoryRouter initialEntries={["/project/p1/terminology"]}>
        <GlossaryEditor />
      </MemoryRouter>,
    )
    await screen.findByTestId("concepts-read-error")

    await expectTooltip(
      screen.getByRole("button", { name: "Add term" }),
      "Terms cannot be added or imported until the termbase loads.",
    )
  })

  it("names the ROLE, not the failed read, when the user is below the floor too", async () => {
    // Both reasons apply at once. "Until the termbase loads" would promise a
    // recovery that never enables this user's button — the read succeeding
    // leaves them just as unable to write.
    mockProject = {
      id: "p1",
      name: "P",
      syncRole: { level: 100 },
      termbaseEditMinRole: 500,
    } as unknown as ProjectRecord
    fetchConcepts.mockRejectedValue(readFailure())
    renderWithTooltips(
      <MemoryRouter initialEntries={["/project/p1/terminology"]}>
        <GlossaryEditor />
      </MemoryRouter>,
    )
    await screen.findByTestId("concepts-read-error")

    const importBtn = screen.getByRole("button", { name: /Import/ })
    expect(importBtn).toBeDisabled()
    await expectTooltip(importBtn, /Project lead/i)
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/until the termbase loads/)
  })

  // AQU-872: Add term names the CONTRIBUTOR bar, since that is the role this
  // viewer is short of for a suggestion — quoting the management floor would
  // tell them to go get a permission they do not need.
  it("names the contributor bar on Add term, still ahead of the failed read", async () => {
    mockProject = {
      id: "p1",
      name: "P",
      syncRole: { level: 100 },
      termbaseEditMinRole: 500,
    } as unknown as ProjectRecord
    fetchConcepts.mockRejectedValue(readFailure())
    renderWithTooltips(
      <MemoryRouter initialEntries={["/project/p1/terminology"]}>
        <GlossaryEditor />
      </MemoryRouter>,
    )
    await screen.findByTestId("concepts-read-error")

    const add = screen.getByRole("button", { name: "Add term" })
    expect(add).toBeDisabled()
    await expectTooltip(add, /at least Contributor access/i)
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/until the termbase loads/)
  })

  it("recovers on Retry without a reload", async () => {
    fetchConcepts.mockRejectedValueOnce(readFailure()).mockResolvedValue([concept()])
    renderEditor()

    fireEvent.click(await screen.findByTestId("concepts-read-retry"))

    expect(await screen.findByText("grace")).toBeInTheDocument()
    expect(screen.queryByTestId("concepts-read-error")).not.toBeInTheDocument()
  })

  it("still shows the empty state for a termbase that is genuinely empty", async () => {
    fetchConcepts.mockResolvedValue([])
    renderEditor()

    expect(await screen.findByText(/No terms yet/)).toBeInTheDocument()
    expect(screen.queryByTestId("concepts-read-error")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add term" })).toBeEnabled()
    expect(screen.getByRole("button", { name: /Import/ })).toBeEnabled()
  })

  it("keeps the last good terms and warns non-blockingly when a LATER read fails", async () => {
    fetchConcepts.mockResolvedValueOnce([concept()]).mockRejectedValue(readFailure())
    renderEditor()
    expect(await screen.findByText("grace")).toBeInTheDocument()

    // The hook's own re-read trigger: a term.* event landing for this project.
    appliedListener?.([{ project: "p1", kind: "term.update" }])

    await waitFor(() => {
      expect(screen.getByTestId("concepts-refresh-stale")).toBeInTheDocument()
    })
    // Non-blocking: the last good termbase stays on screen and stays editable.
    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.queryByTestId("concepts-read-error")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add term" })).toBeEnabled()
  })

  it("renders the failure on the WORKSPACE-OWNED path, where the record carries only terms", () => {
    // ProjectWorkspace owns the read here and folds `terminology` onto the
    // record — so the failure can only arrive as its own prop.
    renderEditor({
      project: { id: "p1", name: "P", terminology: [] } as unknown as ProjectRecord,
      conceptsError: "concepts-read failed: HTTP 500 — concepts read failed",
    })

    expect(screen.getByTestId("concepts-read-error")).toBeInTheDocument()
    expect(screen.queryByText(/No terms yet/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add term" })).toBeDisabled()
    // The standalone hook must not have fired on this path.
    expect(fetchConcepts).not.toHaveBeenCalled()
  })

  it("shows the in-flight read as progress, not as an empty termbase", async () => {
    let settle: (value: Concept[]) => void = () => {}
    fetchConcepts.mockImplementation(() => new Promise((res) => { settle = res }))
    renderEditor()

    // The read is only in flight once the token has been minted, which is a
    // microtask later — waiting on the call is what makes this deterministic.
    await waitFor(() => expect(fetchConcepts).toHaveBeenCalled())
    expect(screen.queryByText(/No terms yet/)).not.toBeInTheDocument()

    settle([])
    expect(await screen.findByText(/No terms yet/)).toBeInTheDocument()
  })
})
