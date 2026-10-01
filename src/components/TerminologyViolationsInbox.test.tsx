/**
 * AQU-663 — the Violations inbox must identify an infringing cell by something a
 * reviewer can act on (its ref/tag + the file it lives in), never by the raw
 * internal cell id.
 *
 * The guard is at component level on purpose: `violationCellRef` is unit-tested
 * in `src/lib/terminology/violations-inbox.test.ts`, but the bug this fixes was
 * the COMPONENT's `cell?.cellLabel ?? inf.cellId` fallback. A test of the helper
 * alone would have passed against the broken row.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { t as en } from "@/lib/i18n/standalone"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import { TerminologyViolationsInbox } from "./TerminologyViolationsInbox"

/** An internal id of exactly the shape the old fallback leaked to the reviewer. */
const CELL_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
const FILE_ID = "8c1f0a2e-1111-4222-8333-444455556666"

const concepts: Concept[] = [
  {
    id: "c1",
    sourceTerm: "spirit",
    // A preferred rendering is what makes the concept enforceable: the compiler
    // emits `term:c1:approved`, and a target missing "esprit" is an infraction.
    renderings: [{ rendering: "esprit", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
]

function makeCell(over: Partial<CellData> = {}): CellData {
  return {
    id: CELL_UUID,
    fileId: FILE_ID,
    original: "the spirit of the waters",
    translated: "le souffle des eaux",
    context: "GEN 1:2",
    group: "g",
    type: "text",
    status: "unvalidated",
    validationStatus: { validated: false },
    ...over,
  } as unknown as CellData
}

function renderInbox(over: {
  cell?: CellData
  files?: Array<{ id: string; name: string }>
  onJumpToCell?: (cell: { cellId: string; fileId: string }) => void
} = {}) {
  return render(
    <I18nProvider>
      <TerminologyViolationsInbox
        concepts={concepts}
        cells={[over.cell ?? makeCell()]}
        files={over.files ?? [{ id: FILE_ID, name: "Genesis.usfm" }]}
        onJumpToCell={over.onJumpToCell ?? (() => {})}
      />
    </I18nProvider>,
  )
}

/** Expand the one concept group so its infringing-cell rows render. */
async function expandGroup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { expanded: false }))
}

describe("TerminologyViolationsInbox infringing-cell rows (AQU-663)", () => {
  it("names the cell by its canonical ref, not the raw internal id", async () => {
    const user = userEvent.setup()
    renderInbox()
    await expandGroup(user)

    expect(screen.getByRole("button", { name: "GEN 1:2" })).toBeTruthy()
    expect(screen.queryByText(CELL_UUID)).toBeNull()
  })

  it("shows a localized placeholder rather than the id when the cell has no ref", async () => {
    const user = userEvent.setup()
    // Importers store opaque UUIDs as canonical refs, so an id can arrive via
    // `context` too — the row must still refuse to show it.
    renderInbox({ cell: makeCell({ context: CELL_UUID, cellLabel: undefined }) })
    await expandGroup(user)

    expect(
      screen.getByRole("button", { name: en("terminology.violations.unnamedCell") }),
    ).toBeTruthy()
    expect(screen.queryByText(CELL_UUID)).toBeNull()
  })

  it("represents the file by name, not by its id", async () => {
    const user = userEvent.setup()
    renderInbox()
    await expandGroup(user)

    const inFile = en("terminology.violations.inFile", { file: "Genesis.usfm" })
    expect(screen.getAllByText(inFile).length).toBeGreaterThan(0)
    expect(screen.queryByText(FILE_ID)).toBeNull()
  })

  it("omits the file affordance when the file is unknown, rather than falling back to the id", async () => {
    const user = userEvent.setup()
    renderInbox({ files: [] })
    await expandGroup(user)

    expect(screen.getByRole("button", { name: "GEN 1:2" })).toBeTruthy()
    expect(screen.queryByText(FILE_ID)).toBeNull()
  })

  it("keeps jump-to-cell working from the ref", async () => {
    const user = userEvent.setup()
    const onJumpToCell = vi.fn()
    renderInbox({ onJumpToCell })
    await expandGroup(user)

    await user.click(screen.getByRole("button", { name: "GEN 1:2" }))
    expect(onJumpToCell).toHaveBeenCalledWith({ cellId: CELL_UUID, fileId: FILE_ID })
  })
})
