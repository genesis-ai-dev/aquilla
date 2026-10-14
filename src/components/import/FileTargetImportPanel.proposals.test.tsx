/**
 * FileTargetImportPanel — "Import as proposals" (AQU-1673).
 *
 * WHY: partners already hold candidate translations (an earlier tool, a
 * consultant, an external MT pass) and want them REVIEWED, not written. The
 * direct import commits the text; this mode stages the same reviewed rows as
 * one changeset behind the human approval gate.
 *
 * The two modes share the whole mapping/review flow, so the only thing that
 * distinguishes them is where the final button sends the rows. That makes the
 * following correctness, not cosmetics:
 *
 *   - proposal mode must NOT commit (no `applyEBibleTargetImport`), and
 *   - must NOT patch the editor optimistically. The direct path paints the
 *     imported text into the cells immediately because it really is being
 *     written. Doing that here would show the user text no cell holds — the
 *     precise lie this mode exists to avoid.
 *   - commit mode must be untouched by any of it.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/lib/import", () => ({ applyEBibleTargetImport: vi.fn() }))
vi.mock("@/lib/import-file-target-proposals", () => ({
  stageTargetImportAsProposals: vi.fn(),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { FileTargetImportPanel } from "./FileTargetImportPanel"
import { applyEBibleTargetImport } from "@/lib/import"
import { stageTargetImportAsProposals } from "@/lib/import-file-target-proposals"

const BASE_CELLS = [
  {
    cellId: "cell-gen-1-1",
    fileId: "file-1",
    canonicalRef: "GEN 1:1",
    sourceEventId: "se-1",
    translated: "",
    original: "In the beginning",
  },
]

const USFM_FIXTURE = `\\id GEN
\\c 1
\\v 1 First verse translation
`

function renderPanel(overrides: Partial<React.ComponentProps<typeof FileTargetImportPanel>> = {}) {
  const applyOptimisticTargetEdits = vi.fn()
  const onProposalsStaged = vi.fn()
  const onImported = vi.fn()
  const onError = vi.fn()
  render(
    <FileTargetImportPanel
      projectId="proj-1"
      username="tester"
      fileName="Genesis.usfm"
      cells={BASE_CELLS}
      getToken={async () => "tok"}
      onImported={onImported}
      onCancel={() => {}}
      onError={onError}
      applyOptimisticTargetEdits={applyOptimisticTargetEdits}
      targetLang=""
      {...overrides}
    />,
  )
  return { applyOptimisticTargetEdits, onProposalsStaged, onImported, onError }
}

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement

async function selectFile(file: File) {
  const input = fileInput()
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function clickApply(name: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function reachReview(
  overrides: Partial<React.ComponentProps<typeof FileTargetImportPanel>> = {},
) {
  const handles = renderPanel(overrides)
  await selectFile(new File([USFM_FIXTURE], "genesis.usfm", { type: "text/plain" }))
  await screen.findByText(/review matches/i)
  return handles
}

describe("FileTargetImportPanel — proposal mode (AQU-1673)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 1, skippedCount: 0 })
    vi.mocked(stageTargetImportAsProposals).mockResolvedValue({
      stagedCount: 1,
      skippedUnchangedCount: 0,
      changesetId: "cs-1",
    })
  })

  it("stages the reviewed rows instead of committing them", async () => {
    const { onProposalsStaged } = await reachReview({
      mode: "proposal",
      jwt: "jwt-1",
      onProposalsStaged: vi.fn(),
    })
    void onProposalsStaged
    await clickApply(/propose 1/i)

    expect(stageTargetImportAsProposals).toHaveBeenCalledTimes(1)
    expect(applyEBibleTargetImport).not.toHaveBeenCalled()
  })

  it("passes the destination lane and the uploaded file name as provenance", async () => {
    await reachReview({ mode: "proposal", jwt: "jwt-1", targetLang: "es" })
    await clickApply(/propose 1/i)

    const ctx = vi.mocked(stageTargetImportAsProposals).mock.calls[0][2]
    expect(ctx).toMatchObject({
      jwt: "jwt-1",
      projectId: "proj-1",
      targetLang: "es",
      sourceFileName: "genesis.usfm",
    })
  })

  it("does NOT patch the editor — nothing is committed until approval", async () => {
    const { applyOptimisticTargetEdits } = await reachReview({ mode: "proposal", jwt: "jwt-1" })
    await clickApply(/propose 1/i)
    expect(applyOptimisticTargetEdits).not.toHaveBeenCalled()
  })

  it("reports the staged outcome to the host rather than a committed count", async () => {
    const onProposalsStaged = vi.fn()
    const { onImported } = await reachReview({
      mode: "proposal",
      jwt: "jwt-1",
      onProposalsStaged,
    })
    await clickApply(/propose 1/i)

    expect(onProposalsStaged).toHaveBeenCalledWith({
      stagedCount: 1,
      skippedUnchangedCount: 0,
      changesetId: "cs-1",
    })
    expect(onImported).not.toHaveBeenCalled()
  })

  it("says the rows are staged for review, not written", async () => {
    await reachReview({ mode: "proposal", jwt: "jwt-1" })
    expect(screen.getByText(/staged as proposals for review/i)).toBeInTheDocument()
  })

  it("reports a staging failure in place and leaves the editor alone", async () => {
    vi.mocked(stageTargetImportAsProposals).mockRejectedValue(new Error("522 from the gate"))
    const { applyOptimisticTargetEdits, onError } = await reachReview({
      mode: "proposal",
      jwt: "jwt-1",
    })
    await clickApply(/propose 1/i)

    expect(await screen.findByText(/522 from the gate/)).toBeInTheDocument()
    expect(applyOptimisticTargetEdits).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith("522 from the gate", "apply")
  })

  it("says so when every selected row already matches the current translation", async () => {
    vi.mocked(stageTargetImportAsProposals).mockResolvedValue({
      stagedCount: 0,
      skippedUnchangedCount: 1,
      changesetId: null,
    })
    const onProposalsStaged = vi.fn()
    await reachReview({ mode: "proposal", jwt: "jwt-1", onProposalsStaged })
    await clickApply(/propose 1/i)

    expect(await screen.findByText(/nothing to propose/i)).toBeInTheDocument()
    // Nothing was staged, so the dialog must not report success and close.
    expect(onProposalsStaged).not.toHaveBeenCalled()
  })

  it("refuses to stage without a session rather than silently dropping the import", async () => {
    const { onError } = await reachReview({ mode: "proposal", jwt: null })
    await clickApply(/propose 1/i)

    expect(stageTargetImportAsProposals).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.any(String), "apply")
  })
})

describe("FileTargetImportPanel — the direct import is unchanged (AQU-1673)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 1, skippedCount: 0 })
  })

  it("still commits, and still patches the editor, with no mode passed", async () => {
    const { applyOptimisticTargetEdits, onImported } = await reachReview()
    await clickApply(/import 1/i)

    expect(applyEBibleTargetImport).toHaveBeenCalledTimes(1)
    expect(stageTargetImportAsProposals).not.toHaveBeenCalled()
    expect(applyOptimisticTargetEdits).toHaveBeenCalled()
    expect(onImported).toHaveBeenCalledWith(1)
  })

  it("tells the user the text is written straight into the file", async () => {
    await reachReview()
    expect(screen.getByText(/written straight into the file/i)).toBeInTheDocument()
  })
})
