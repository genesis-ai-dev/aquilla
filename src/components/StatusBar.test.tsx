// AQU-1083. The editor footer is the ONE progress surface that counts cells
// itself — every other one renders a number the server already resolved the
// policy against — so it is the one place the policy can silently disagree
// with the rest of the app for the same file.

import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { StatusBar } from "./StatusBar"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { CellSummary } from "@/hooks/useActiveCellStore"

const cell = (id: string, type: string, status: CellSummary["status"]): CellSummary =>
  ({ id, cellLabel: id, type, status } as CellSummary)

/** Two verses (one translated) and two headings (both translated). */
const CELLS: CellSummary[] = [
  cell("v1", "verse", "unvalidated"),
  cell("v2", "verse", "empty"),
  cell("h1", "heading", "validated"),
  cell("h2", "paratext", "unvalidated"),
]

function renderBar(countStructural?: boolean) {
  return render(
    <I18nProvider>
      <StatusBar
        cells={CELLS}
        projectHealth={100}
        healthMap={new Map(CELLS.map((c) => [c.id, 100]))}
        countStructural={countStructural}
      />
    </I18nProvider>,
  )
}

/** Bidi isolates wrap every formatted number (an Arabic reordering fix), so
 *  strip them before matching or every assertion here is unreadable. */
const plain = (el: HTMLElement) => (el.textContent ?? "").replace(/[\u2066-\u2069]/g, "")

describe("StatusBar and the structural-cell policy", () => {
  it("counts headings by default", () => {
    // Absent policy must behave exactly as the footer did before the setting
    // existed: four cells, three of them with content.
    const { container } = renderBar()
    expect(plain(container)).toContain("4 cells")
    expect(plain(container)).toContain("3")
  })

  it("drops headings from both halves of the ratio when excluded", () => {
    // Not just the denominator: a translated chapter title must leave the
    // numerator too, or the percentage climbs for work nobody did. Two verses
    // remain, one of them translated — 50%, not 75%.
    const { container } = renderBar(false)
    expect(plain(container)).toContain("2 cells")
    expect(plain(container)).toContain("50")
    expect(plain(container)).not.toContain("4 cells")
  })
})
