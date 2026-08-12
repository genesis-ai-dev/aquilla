/**
 * FileDetailsModal — permission-aware action gating.
 *
 * The modal must always SHOW every file action, but disable (with a visible
 * reason) the ones the caller lacks permission for:
 *   - Delete requires project_lead (500)+ (AQU-271).
 *   - Export requires an exportable type (USFM) AND org export policy (AQU-253).
 * Rename/Move carry no role gate today and must stay enabled.
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import type { FileReference } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
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
  const handlers = {
    onRename: vi.fn(), onMove: vi.fn(), onExportSource: vi.fn(), onDelete: vi.fn(),
  }
  render(
    <I18nProvider>
      <FileDetailsModal
        file={usfmFile}
        open
        onOpenChange={vi.fn()}
        roleLevel={ROLE.OWNER}
        canExportByOrgPolicy
        {...handlers}
        {...overrides}
      />
    </I18nProvider>,
  )
  return handlers
}

describe("FileDetailsModal", () => {
  it("shows file metadata", () => {
    renderModal()
    expect(screen.getByText("Genesis")).toBeTruthy()
    expect(screen.getByText("USFM")).toBeTruthy()
    expect(screen.getByText("GEN")).toBeTruthy()
    expect(screen.getByText("1533")).toBeTruthy()
  })

  it("enables all actions for project_lead+ on an exportable file", () => {
    const h = renderModal({ roleLevel: ROLE.PROJECT_LEAD })
    for (const name of [/rename/i, /move to corpus/i, /export source/i, /^delete$/i]) {
      const btn = screen.getByRole("button", { name }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    }
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    expect(h.onDelete).toHaveBeenCalledOnce()
  })

  it("disables Delete with a reason below project_lead, keeping it visible", () => {
    const h = renderModal({ roleLevel: ROLE.CONTRIBUTOR })
    const btn = screen.getByRole("button", { name: /^delete$/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(/requires the project lead role/i)).toBeTruthy()
    fireEvent.click(btn)
    expect(h.onDelete).not.toHaveBeenCalled()
    // Rename/Move stay enabled — they carry no role gate.
    expect((screen.getByRole("button", { name: /rename/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("disables Export when org policy forbids it", () => {
    renderModal({ canExportByOrgPolicy: false })
    const btn = screen.getByRole("button", { name: /export source/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(/organization's export policy/i)).toBeTruthy()
  })

  it("disables Export for non-USFM files with a type reason", () => {
    renderModal({ file: { ...usfmFile, type: "txt" } })
    const btn = screen.getByRole("button", { name: /export source/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(/only usfm files/i)).toBeTruthy()
  })
})
