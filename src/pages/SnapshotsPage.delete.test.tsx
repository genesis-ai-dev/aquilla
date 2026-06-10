/**
 * SnapshotsPage.delete.test.tsx — FRO-291 delete-confirm guard.
 *
 * Verifies that snapshot delete is gated by the checkbox-confirm dialog:
 * clicking the trash icon does NOT call remove immediately; cancel leaves
 * data untouched; remove fires only after checkbox+confirm.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { SnapshotsPage } from "./SnapshotsPage"
import type { Snapshot } from "@/hooks/useSnapshots"

// ── Stubs ─────────────────────────────────────────────────────────────────

const removeMock = vi.fn()
const restoreMock = vi.fn()
const createMock = vi.fn()
const revalidateMock = vi.fn()

let snapshotsStub: Snapshot[] = []

vi.mock("@/hooks/useSnapshots", () => ({
  useSnapshots: () => ({
    snapshots: snapshotsStub,
    isLoading: false,
    isError: false,
    revalidate: revalidateMock,
    create: createMock,
    remove: removeMock,
    restore: restoreMock,
  }),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok" }, loading: false }),
}))

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: {
      id: "proj-1",
      name: "Test Project",
      syncRole: { level: 700, source: "creator" },
    },
    loading: false,
  }),
}))

vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildFileScopedTokenFetcher: () => async () => "tok",
}))

vi.mock("@/components/SnapshotCreateDialog", () => ({
  SnapshotCreateDialog: () => null,
}))

vi.mock("@/components/SnapshotRestoreDialog", () => ({
  SnapshotRestoreDialog: () => null,
}))

vi.mock("@/lib/frontier/roles", () => ({
  ROLE: { MAINTAINER: 500 },
}))

// ── Helpers ───────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "snap-1",
    name: "v1.0 baseline",
    description: "Initial snapshot",
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "tester",
    ...overrides,
  } as Snapshot
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/project/proj-1/snapshots"]}>
      <Routes>
        <Route path="/project/:id/snapshots" element={<SnapshotsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("SnapshotsPage snapshot delete confirm (FRO-291)", () => {
  beforeEach(() => {
    removeMock.mockReset()
    snapshotsStub = [makeSnapshot()]
  })

  it("does NOT call remove immediately when trash icon is clicked", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText("v1.0 baseline")).toBeInTheDocument())

    fireEvent.click(screen.getByTitle("Delete snapshot"))

    expect(removeMock).not.toHaveBeenCalled()
  })

  it("shows confirm dialog with consequence copy after clicking delete", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText("v1.0 baseline")).toBeInTheDocument())

    fireEvent.click(screen.getByTitle("Delete snapshot"))

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Delete snapshot/i })).toBeInTheDocument()
    )
    expect(screen.getAllByText(/everyone in the project/i).length).toBeGreaterThan(0)
  })

  it("cancel leaves remove uncalled", async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText("v1.0 baseline")).toBeInTheDocument())

    fireEvent.click(screen.getByTitle("Delete snapshot"))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(removeMock).not.toHaveBeenCalled()
  })

  it("calls remove only after checkbox is checked and confirm button is clicked", async () => {
    removeMock.mockResolvedValue(undefined)
    renderPage()
    await waitFor(() => expect(screen.getByText("v1.0 baseline")).toBeInTheDocument())

    fireEvent.click(screen.getByTitle("Delete snapshot"))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())

    // Confirm button is disabled before checkbox
    const confirmBtn = screen.getByRole("button", { name: /^Delete snapshot$/i })
    expect(confirmBtn).toBeDisabled()

    // Check the checkbox
    const checkbox = screen.getByRole("checkbox")
    fireEvent.click(checkbox)
    expect(confirmBtn).not.toBeDisabled()

    // Confirm
    fireEvent.click(confirmBtn)
    expect(removeMock).toHaveBeenCalledWith("snap-1")
  })
})
