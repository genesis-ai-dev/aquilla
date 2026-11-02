// AQU-2259: the Sources and Check menu rows were hard-coded English ("Film",
// "Audio cues", "Subtitles", "Characters", "Check links"), so they stayed
// English in every language. Rendered here through a marking translator: a
// label that skips t() comes out unmarked.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { translate } from "@/lib/i18n/translate"
import { TimelineEditor } from "./TimelineEditor"

vi.mock("@/lib/i18n/I18nProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/I18nProvider")>()
  const marked = (key: string, vars?: Record<string, unknown>) =>
    `⟦${translate(undefined, key as never, vars as never)}⟧`
  return { ...actual, useT: () => marked }
})

describe("timeline menus go through translation (AQU-2259)", () => {
  it("labels every Sources row from the catalog", () => {
    render(
      <TimelineEditor
        fileId="f1"
        coreMediaUrl={null}
        editable
        cells={[]}
        onRetimeSubtitle={() => {}}
        onRequestLinkVideo={() => {}}
        canLinkVideo
        onRequestImportAudioVtt={() => {}}
        canImportAudioVtt
        onRequestExtractSubtitles={() => {}}
        canExtractSubtitles
        onRequestImportCharacters={() => {}}
        canImportCharacters
      />,
    )
    fireEvent.click(screen.getByTestId("tl-sources-menu"))
    const rows = screen.getAllByRole("menuitem")
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const row of rows) {
      // The row's own label, before its badge.
      expect(row.textContent?.trimStart().startsWith("⟦")).toBe(true)
    }
    expect(screen.getByRole("menuitem", { name: /⟦Film⟧/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /⟦Audio cues⟧/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /⟦Subtitles⟧/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /⟦Characters⟧/ })).toBeInTheDocument()
  })
})
