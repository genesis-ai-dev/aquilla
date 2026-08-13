/**
 * FileDetailsModal — metadata only.
 *
 * File actions (rename / move / export / delete) live on the row menu, not
 * in this dialog.
 */

import { render, screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import type { FileReference } from "@/lib/parsers/types"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { FileDetailsModal } from "./FileDetailsModal"

const usfmFile: FileReference = {
  id: "f1",
  name: "Genesis",
  type: "usfm",
  createdAt: "2026-01-15T00:00:00.000Z",
  cellCount: 1533,
  corpusMarker: "OT",
  bookCode: "GEN",
}

function renderModal(overrides: Partial<Parameters<typeof FileDetailsModal>[0]> = {}) {
  render(
    <I18nProvider>
      <FileDetailsModal
        file={usfmFile}
        open
        onOpenChange={vi.fn()}
        {...overrides}
      />
    </I18nProvider>,
  )
}

describe("FileDetailsModal", () => {
  it("shows file metadata", () => {
    renderModal()
    expect(screen.getByText("Genesis")).toBeTruthy()
    expect(screen.getByText("USFM")).toBeTruthy()
    expect(screen.getByText("GEN")).toBeTruthy()
    expect(screen.getByText("1533")).toBeTruthy()
  })

  it("does not render file actions", () => {
    renderModal()
    expect(screen.queryByRole("button", { name: /rename/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /move to corpus/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /export source/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull()
  })

  it("shows progress when stats are provided", () => {
    renderModal({ progress: { translated: 10, validated: 5, total: 20 } })
    expect(screen.getByText(/50% translated/i)).toBeTruthy()
    expect(screen.getByText(/25% validated/i)).toBeTruthy()
  })
})
