// AQU-1688 — the "Language profile for checks" card.
//
// WHY: the quotation checks stay dormant until this card stores marks, so it
// must (1) say plainly when nothing is set, (2) fill in the target language's
// usual marks on request, (3) store only a valid slot, merged over the rest of
// the profile so a later slot (AQU-1691) is never wiped, and (4) surface a
// failed save instead of swallowing it.

import { describe, it, expect, vi } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { LanguageProfileSection, type LanguageProfileSectionProps } from "./LanguageProfileSection"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { LanguageProfile } from "../../../db/shared/language-profile"

function renderCard(overrides: Partial<LanguageProfileSectionProps> = {}) {
  const props: LanguageProfileSectionProps = {
    value: undefined,
    targetLanguage: "French",
    canEdit: true,
    disabledTooltip: null,
    patch: vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" })),
    ...overrides,
  }
  renderWithTooltips(<LanguageProfileSection {...props} />)
  return props
}

const mark = (side: "Opening" | "Closing", level: string) =>
  screen.getByRole("textbox", { name: `${side} mark: ${level}` }) as HTMLInputElement

describe("LanguageProfileSection", () => {
  it("says the quotation checks are off while no marks are saved", () => {
    renderCard()
    expect(screen.getByText(/Not set\. The quotation checks stay off/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear quotation marks" })).toBeNull()
  })

  it("fills in the target language's usual marks, then saves them as the quoteMarks slot", async () => {
    const props = renderCard()
    fireEvent.click(screen.getByRole("button", { name: /Use defaults for/ }))
    expect([mark("Opening", "Quotation").value, mark("Closing", "Quotation").value]).toEqual(["«", "»"])
    expect(mark("Opening", "Inside a quotation").value).toBe("“")
    fireEvent.click(screen.getByRole("button", { name: "Save quotation marks" }))
    await waitFor(() => expect(props.patch).toHaveBeenCalledTimes(1))
    expect(props.patch).toHaveBeenCalledWith({
      languageProfile: {
        quoteMarks: {
          levels: [{ open: "«", close: "»" }, { open: "“", close: "”" }, { open: "‘", close: "’" }],
          continuation: "reopen-each-paragraph",
        },
      },
    })
    expect(await screen.findByText("Quotation marks saved.")).toBeInTheDocument()
  })

  // A slot this client does not know yet (one AQU-1691 adds) must survive.
  const stored = {
    quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "none" },
    futureSlot: { kept: true },
  } as unknown as LanguageProfile

  it("keeps other Language-profile slots when it saves quotation marks", async () => {
    const props = renderCard({ value: stored })
    fireEvent.change(mark("Opening", "Quotation"), { target: { value: "«" } })
    fireEvent.change(mark("Closing", "Quotation"), { target: { value: "»" } })
    fireEvent.click(screen.getByRole("button", { name: "Save quotation marks" }))
    await waitFor(() => expect(props.patch).toHaveBeenCalledTimes(1))
    expect(props.patch).toHaveBeenCalledWith({
      languageProfile: {
        futureSlot: { kept: true },
        quoteMarks: { levels: [{ open: "«", close: "»" }], continuation: "none" },
      },
    })
  })

  it("clears only the quotation marks", async () => {
    const props = renderCard({ value: stored })
    fireEvent.click(screen.getByRole("button", { name: "Clear quotation marks" }))
    await waitFor(() => expect(props.patch).toHaveBeenCalledTimes(1))
    expect(props.patch).toHaveBeenCalledWith({ languageProfile: { futureSlot: { kept: true } } })
  })

  it("refuses a half-filled level instead of saving it", () => {
    const props = renderCard()
    fireEvent.change(mark("Opening", "Quotation"), { target: { value: "“" } })
    fireEvent.click(screen.getByRole("button", { name: "Save quotation marks" }))
    expect(props.patch).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/Each mark is one punctuation character/)
  })

  it("shows why a save failed", async () => {
    renderCard({
      value: { quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "none" } },
      patch: vi.fn(async (): Promise<PatchOutcome> => ({ kind: "blocked", reason: "role" })),
    })
    fireEvent.click(screen.getByRole("button", { name: "Save quotation marks" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Only a maintainer can change the Language profile.")
  })

  it("shows the stored marks, and locks every control below the maintainer floor", () => {
    renderCard({
      canEdit: false,
      value: { quoteMarks: { levels: [{ open: "„", close: "“" }, { open: "‚", close: "‘" }], continuation: "reopen-each-paragraph" } },
    })
    expect(mark("Opening", "Quotation").value).toBe("„")
    expect(mark("Closing", "Inside a quotation").value).toBe("‘")
    expect(mark("Opening", "Quotation")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save quotation marks" })).toBeDisabled()
  })

  it("offers no defaults for a language neither table knows", () => {
    renderCard({ targetLanguage: "tpi" })
    expect(screen.queryByRole("button", { name: /Use defaults for/ })).toBeNull()
  })
})
