/**
 * AQU-663 — the Violations inbox must identify an infringing cell by something a
 * reviewer can act on (its ref/tag + the file it lives in), never by the raw
 * internal cell id.
 *
 * The guard is at component level on purpose: `violationCellRef` is unit-tested
 * in `src/lib/terminology/violations-inbox.test.ts`, but the bug this fixes was
 * the COMPONENT's `cell?.cellLabel ?? inf.cellId` fallback. A test of the helper
 * alone would have passed against the broken row.
 *
 * AQU-1888 — and the scan behind those rows must go through the shared
 * incremental scan, not a render-time memo over the whole corpus. See the last
 * describe block.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { t as en } from "@/lib/i18n/standalone"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import { TerminologyViolationsInbox } from "./TerminologyViolationsInbox"

/**
 * AQU-1888: both entry points of the rule engine are spied on. The eager
 * whole-corpus `checkRules` is the defect — it must never be reached from this
 * surface; `checkRulesForCell` is what the incremental scan calls, once per
 * cell that actually needs re-evaluating.
 */
const eagerScanSpy = vi.hoisted(() => vi.fn())
const perCellSpy = vi.hoisted(() => vi.fn())
vi.mock("@/lib/rules/rule-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rules/rule-engine")>()
  eagerScanSpy.mockImplementation(actual.checkRules)
  perCellSpy.mockImplementation(actual.checkRulesForCell)
  return {
    ...actual,
    checkRules: (...args: Parameters<typeof actual.checkRules>) => eagerScanSpy(...args),
    checkRulesForCell: (...args: Parameters<typeof actual.checkRulesForCell>) =>
      perCellSpy(...args),
  }
})

afterEach(() => {
  eagerScanSpy.mockClear()
  perCellSpy.mockClear()
})

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

/**
 * Expand the one concept group so its infringing-cell rows render.
 *
 * AQU-1888: the group arrives from a scan sliced across frames, so this waits
 * for the row rather than reading it out of the first render pass.
 */
async function expandGroup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { expanded: false }))
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

describe("TerminologyViolationsInbox term scan (AQU-1888)", () => {
  /** A corpus big enough that an eager pass would be the whole project. */
  function corpus(size: number): CellData[] {
    return Array.from({ length: size }, (_, i) =>
      makeCell({
        id: `cell-${i}`,
        original: "the spirit of the waters",
        translated: `le souffle des eaux ${i}`,
        context: `GEN 1:${i + 1}`,
      }),
    )
  }

  function renderWithCells(cells: CellData[]) {
    return render(
      <I18nProvider>
        <TerminologyViolationsInbox concepts={concepts} cells={cells} />
      </I18nProvider>,
    )
  }

  it("never runs the eager whole-corpus scan, and still reports the same groups", async () => {
    renderWithCells(corpus(40))

    // The eager scan is the defect: reaching it at all means the memo is back.
    expect(eagerScanSpy).not.toHaveBeenCalled()
    // Nothing is evaluated during the render pass either.
    expect(perCellSpy).not.toHaveBeenCalled()

    // The group still arrives — every cell is missing the approved rendering.
    const group = await screen.findByRole("button", { expanded: false })
    expect(group.textContent).toContain("spirit")
    expect(await screen.findByText("40")).toBeTruthy()
    expect(eagerScanSpy).not.toHaveBeenCalled()
  })

  it("says the list is still filling in rather than claiming the project is clean", async () => {
    renderWithCells(corpus(40))

    expect(screen.getByTestId("terminology-violations-scanning")).toBeTruthy()
    expect(screen.queryByText(en("terminology.violations.emptyTitle"))).toBeNull()

    await screen.findByRole("button", { expanded: false })
    expect(screen.queryByTestId("terminology-violations-scanning")).toBeNull()
  })

  it("re-evaluates one cell when one cell changes, not the corpus", async () => {
    const cells = corpus(40)
    const { rerender } = renderWithCells(cells)
    await screen.findByRole("button", { expanded: false })

    const afterFirstScan = perCellSpy.mock.calls.length
    expect(afterFirstScan).toBe(cells.length)

    // What the outbox does on a keystroke: a brand-new array, same cells but
    // one, so the old memo re-scanned all 40.
    const edited = cells.map((cell, i) =>
      i === 7 ? { ...cell, translated: "l’esprit des eaux" } : cell,
    )
    rerender(
      <I18nProvider>
        <TerminologyViolationsInbox concepts={concepts} cells={edited} />
      </I18nProvider>,
    )

    // The edited cell now carries the approved rendering, so its infraction
    // goes away and the count drops by exactly one.
    expect(await screen.findByText("39")).toBeTruthy()
    expect(perCellSpy.mock.calls.length).toBe(afterFirstScan + 1)
  })

  it("compiles and scans nothing when the caller passes server rows", async () => {
    render(
      <I18nProvider>
        <TerminologyViolationsInbox
          concepts={concepts}
          rows={[
            {
              conceptId: "c1",
              sourceTerm: "spirit",
              kind: "missing-approved",
              cellId: CELL_UUID,
              fileId: FILE_ID,
              original: "the spirit of the waters",
              translated: "le souffle des eaux",
              context: "GEN 1:2",
            },
          ]}
        />
      </I18nProvider>,
    )

    expect(await screen.findByText("1")).toBeTruthy()
    expect(screen.queryByTestId("terminology-violations-scanning")).toBeNull()
    expect(eagerScanSpy).not.toHaveBeenCalled()
    expect(perCellSpy).not.toHaveBeenCalled()
  })
})
