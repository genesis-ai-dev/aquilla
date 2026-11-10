// AQU-2432 (review, Nov 9): the marker's words. It names its line the way the
// text table numbers it (the table's # column), not by the line's place among
// the lines the timeline happens to lay out (a book's chapter), and writes its
// seconds in the reader's own number format.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"

let readerLocale = "en"
vi.mock("@/lib/i18n/I18nProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/I18nProvider")>()
  return { ...actual, useI18n: () => ({ ...actual.useI18n(), locale: readerLocale }) }
})

import { EmptyLineMarker } from "./EmptyLineMarker"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import type { EmptyLineMarkerSpec } from "@/lib/timeline/line-markers"
import type { CellData } from "@/hooks/useCells"

const line = (over: Partial<CellData> = {}) => ({ id: "b", fileId: "f1", original: "b words", translated: "", ...over }) as CellData
const spec = (roomSec: number, cell = line()): EmptyLineMarkerSpec => ({ cell, atPx: 100, tabLeftPx: 94, roomSec, position: 2 })
const said = () => (screen.getByTestId("tl-line-marker-b-tab").getAttribute("aria-label") ?? "").replace(/[⁦-⁩]/g, "")

describe("the marker's words (AQU-2432)", () => {
  it("a line with no label and no reference is named by the table's number for it, not its place on the timeline", () => {
    render(
      <EditorActionsProvider value={{ lineNumberFor: (id) => (id === "b" ? "14" : null) }}>
        <EmptyLineMarker marker={spec(0)} selected={false} onSelect={() => {}} />
      </EditorActionsProvider>,
    )
    expect(said()).toBe("Line 14 isn't recorded yet. It has no room here. Drag the next take later to give it room.")
  })

  it("its label or its reference still come first", () => {
    render(
      <EditorActionsProvider value={{ lineNumberFor: () => "14" }}>
        <EmptyLineMarker marker={spec(0, line({ globalReferences: ["GEN 2:3"] }))} selected={false} onSelect={() => {}} />
      </EditorActionsProvider>,
    )
    expect(said()).toMatch(/^Genesis 2:3 isn't recorded yet\./)
  })

  it("with no table to ask (a line the table does not show), its place on the timeline", () => {
    render(<EmptyLineMarker marker={spec(0)} selected={false} onSelect={() => {}} />)
    expect(said()).toMatch(/^Line 2 isn't recorded yet\./)
  })

  it("the seconds are written in the reader's number format", () => {
    readerLocale = "fr"
    try {
      render(<EmptyLineMarker marker={spec(0.2)} selected={false} onSelect={() => {}} />)
      expect(said()).toBe("Line 2 isn't recorded yet. It has only 0,2 s of room here. Drag the next take later to give it room.")
    } finally {
      readerLocale = "en"
    }
  })
})
