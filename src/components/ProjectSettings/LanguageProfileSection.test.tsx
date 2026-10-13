// AQU-1688 — the "Language profile for checks" card.
//
// WHY: the quotation checks stay dormant until this card stores marks, so it
// must (1) say plainly when nothing is set, (2) fill in the target language's
// usual marks on request, (3) store only a valid slot, merged over the rest of
// the profile so a later slot (AQU-1691) is never wiped, and (4) surface a
// failed save instead of swallowing it.

import { describe, it, expect, vi } from "vitest"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
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

// AQU-1691: one collapsible row per further slot. WHY: most projects fill in
// only a few, so the rows start closed and say only whether they are set; each
// row saves its own slot merged over the stored profile, so neither the
// quotation marks nor a slot this version does not know is ever wiped; and a
// value the slot's validator rejects is refused, not stored.
describe("LanguageProfileSection — the slot rows", () => {
  const row = (slot: string) => screen.getByTestId(`profile-slot-${slot}`)
  const open = (slot: string) => fireEvent.click(within(row(slot)).getByRole("button", { expanded: false }))
  const save = (slot: string) => fireEvent.click(within(row(slot)).getByRole("button", { name: "Save" }))
  const stored = {
    quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "none" },
    futureSlot: { kept: true },
  } as unknown as LanguageProfile

  it("starts every row closed and says only whether its slot is set", () => {
    renderCard({ value: { measures: "convert" } })
    expect(within(row("measures")).getByRole("button", { name: /^Measures/ })).toHaveAttribute("aria-expanded", "false")
    expect(row("measures")).toHaveTextContent(/Set$/)
    expect(row("negators")).toHaveTextContent("Not set")
    expect(screen.queryByLabelText("Negative words")).toBeNull()
  })

  it("saves one slot over the stored profile, keeping the quotation marks and an unknown slot", async () => {
    const props = renderCard({ value: stored })
    open("negators")
    fireEvent.change(screen.getByLabelText("Negative words"), { target: { value: "ne, pas" } })
    save("negators")
    await waitFor(() => expect(props.patch).toHaveBeenCalledTimes(1))
    expect(props.patch).toHaveBeenCalledWith({
      languageProfile: {
        quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "none" },
        futureSlot: { kept: true },
        negators: ["ne", "pas"],
      },
    })
    expect(await within(row("negators")).findByText("Saved.")).toBeInTheDocument()
  })

  it("saves question markers with both fields empty: a question mark only, which turns the question check on", async () => {
    const props = renderCard()
    open("questionMarkers")
    save("questionMarkers")
    await waitFor(() => expect(props.patch).toHaveBeenCalledWith({ languageProfile: { questionMarkers: {} } }))
  })

  it("clears only its own slot", async () => {
    const props = renderCard({ value: { ...stored, measures: "convert" } as LanguageProfile })
    open("measures")
    fireEvent.click(within(row("measures")).getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(props.patch).toHaveBeenCalledWith({ languageProfile: stored }))
  })

  it("refuses a slot its validator rejects instead of storing it", () => {
    const props = renderCard()
    open("divineNames")
    save("divineNames")
    expect(props.patch).not.toHaveBeenCalled()
    expect(within(row("divineNames")).getByRole("alert")).toHaveTextContent(/can't be saved/)
  })

  it("locks every row below the maintainer floor", () => {
    renderCard({ canEdit: false })
    open("speechVerbs")
    expect(screen.getByLabelText("Speech verbs")).toBeDisabled()
    expect(within(row("speechVerbs")).getByRole("button", { name: "Save" })).toBeDisabled()
  })
})
