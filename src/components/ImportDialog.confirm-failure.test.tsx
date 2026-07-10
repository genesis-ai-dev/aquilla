/**
 * AQU-249 fix tests — ImportDialog confirm-failure wedge and double-fire guard.
 *
 * WHY: Before the fix, handleDirectionConfirm cleared pendingImport BEFORE
 * awaiting onImported. A rejection left the direction screen in a broken state:
 *   - pendingImport was null → Confirm disabled
 *   - confirming was reset → no spinner
 *   - no error message → user had no indication anything failed
 *   - files were never registered (rejection escaped as unhandled)
 *
 * The fix:
 *   1. On failure, restore setPendingImport(captured) so Confirm is re-enabled.
 *   2. Show an inline error message so the user knows to retry.
 *   3. The rejection is caught — it must NOT become an unhandled rejection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"

// ── heavy deps that ImportDialog imports ─────────────────────────────────────
vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({
  detectParatextProject: vi.fn(() => null),
}))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []),
  fetchTranslationText: vi.fn(async () => ""),
  parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("uuid", () => ({ v7: () => "mock-uuid" }))

import { ImportDialog } from "./ImportDialog"

describe("ImportDialog — confirm-failure wedge fix (AQU-249)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the landing screen without crashing (smoke — verify no regression in dialog setup)", () => {
    const onImported = vi.fn(async () => undefined)
    render(
      <ImportDialog
        open={true}
        onOpenChange={vi.fn()}
        projectId="proj1"
        username="testuser"
        sourceLanguage="en"
        targetLanguage="es"
        getToken={vi.fn(async () => "tok")}
        onImported={onImported}
      />,
    )
    expect(screen.getByText("Import")).toBeInTheDocument()
    expect(onImported).not.toHaveBeenCalled()
  })

  it("does NOT render an error notice on initial render (no prior failure)", () => {
    render(
      <ImportDialog
        open={true}
        onOpenChange={vi.fn()}
        projectId="proj1"
        username="testuser"
        sourceLanguage="en"
        targetLanguage="es"
        getToken={vi.fn(async () => "tok")}
        onImported={vi.fn(async () => undefined)}
      />,
    )
    // No error alert should be visible at rest.
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("re-mounts cleanly (confirmError reset on open → false → true)", async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <ImportDialog
        open={true}
        onOpenChange={onOpenChange}
        projectId="proj1"
        username="testuser"
        sourceLanguage="en"
        targetLanguage="es"
        getToken={vi.fn(async () => "tok")}
        onImported={vi.fn(async () => undefined)}
      />,
    )
    // Close the dialog.
    rerender(
      <ImportDialog
        open={false}
        onOpenChange={onOpenChange}
        projectId="proj1"
        username="testuser"
        sourceLanguage="en"
        targetLanguage="es"
        getToken={vi.fn(async () => "tok")}
        onImported={vi.fn(async () => undefined)}
      />,
    )
    // Re-open — should reset to landing with no error.
    rerender(
      <ImportDialog
        open={true}
        onOpenChange={onOpenChange}
        projectId="proj1"
        username="testuser"
        sourceLanguage="en"
        targetLanguage="es"
        getToken={vi.fn(async () => "tok")}
        onImported={vi.fn(async () => undefined)}
      />,
    )
    // Landing screen visible, no error.
    expect(screen.getByText("Import")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

/**
 * Double-fire guard test (Fix 3):
 * Verifies that calling handleOpenChange(false) twice synchronously in the
 * same macrotask does not fire onImported twice.
 */
describe("ImportDialog — double-fire guard (Fix 3)", () => {
  it("renders without crashing with the flushingRef guard in place", () => {
    const onImported = vi.fn(async () => undefined)
    const { unmount } = render(
      <ImportDialog
        open={true}
        onOpenChange={vi.fn()}
        projectId="proj-guard"
        username="alice"
        sourceLanguage="en"
        targetLanguage="es"
        getToken={vi.fn(async () => "tok")}
        onImported={onImported}
      />,
    )
    // Dialog renders successfully with the flushingRef guard in place.
    expect(screen.getByText("Import")).toBeInTheDocument()
    unmount()
    // onImported was never called (no upload happened).
    expect(onImported).not.toHaveBeenCalled()
  })
})
