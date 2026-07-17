/**
 * AQU-314 — Cell labels / cast import is reachable from the ImportDialog.
 *
 * WHY: The label-apply engine (LabelImportPanel, `cast.assign` events, template
 * generation, angle splitting) shipped under AQU-316/438/439 and is unit-tested
 * in isolation (see LabelImportPanel.test.tsx). But the PM-facing flow that
 * AQU-314 actually asked for — "download a template → fill cast → re-import" —
 * only works if the dialog's "Cell labels / cast" landing card is wired to that
 * panel AND handed the project's source cells. The panel's own tests mock the
 * dialog away, so nothing guards that wiring; deleting the card or dropping the
 * `sourceCells` prop would leave every unit test green while the feature is dead.
 * This suite is that missing regression guard.
 *
 * Tests:
 *  1. Choosing the "Cell labels / cast" card with source cells present mounts
 *     the LabelImportPanel (its "Download CSV template" step is visible).
 *  2. With no source cells, the card shows the "import a source file first"
 *     guidance instead of a broken/empty panel.
 */

import React from "react"
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

// ── heavy deps ImportDialog pulls in at module load ───────────────────────────
vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  prepareParatextProject: vi.fn(),
  commitParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
// The apply path is exercised by LabelImportPanel.test.tsx; here we only need the
// panel to mount, so stub the event emitter to keep the test hermetic.
vi.mock("@/lib/sync/events-emit", () => ({ emitCastAssign: vi.fn(async () => "evt-test-id") }))
// AQU-314: the panel fetches the picked file's cells itself — stub the read.
vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: vi.fn(async () => [{ cellId: "cell-gen-1-1", canonicalRef: "GEN 1:1" }]),
}))
// ScrollArea uses @base-ui/react which calls getAnimations() — not in happy-dom.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))
// Select is @base-ui/react too — stub with plain elements.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}))

import { ImportDialog } from "./ImportDialog"

const PROJECT_FILES = [
  { id: "file-genesis", name: "Genesis.usfm" },
  { id: "file-exodus", name: "Exodus.usfm" },
]

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-aqu314",
  username: "pm-user",
  sourceLanguage: "hbo",
  targetLanguage: "spa",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

describe("AQU-314 — Cell labels / cast import is wired into the ImportDialog", () => {
  it("mounts the LabelImportPanel when the labels card is chosen and project files exist", () => {
    render(
      <ImportDialog {...baseProps} projectFiles={PROJECT_FILES} activeFileId="file-genesis" />,
    )

    // The landing card exists...
    fireEvent.click(screen.getByText("Cell labels / cast"))

    // ...and routing to it renders the panel (its step-1 download button proves
    // the panel mounted and received the project's files for the picker).
    expect(
      screen.getByRole("button", { name: /Download CSV template/i }),
    ).toBeInTheDocument()
    // AQU-314: the picker lists the project's files.
    expect(screen.getByText("Genesis.usfm")).toBeInTheDocument()
    expect(screen.getByText("Exodus.usfm")).toBeInTheDocument()
  })

  it("shows the source-file-required guidance (not a broken panel) when there are no files", () => {
    render(<ImportDialog {...baseProps} projectFiles={[]} />)

    fireEvent.click(screen.getByText("Cell labels / cast"))

    expect(
      screen.getByText(/Cell labels require an existing source file/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Download CSV template/i }),
    ).toBeNull()
  })
})
