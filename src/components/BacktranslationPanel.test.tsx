import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ComponentProps } from "react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { BacktranslationPanel } from "./BacktranslationPanel"
import type { CellData } from "@/hooks/useCells"

function cell(over: Partial<CellData> = {}): CellData {
  return {
    id: "c1",
    fileId: "f1",
    original: "his house",
    translated: "maison de lui",
    targetEventId: "evt-1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    waivers: [],
    hasPendingEdit: false,
    ...over,
  } as CellData
}

function renderPanel(over: Partial<ComponentProps<typeof BacktranslationPanel>> = {}) {
  const props: ComponentProps<typeof BacktranslationPanel> = {
    cell: cell(),
    visibleTranslated: "maison de lui",
    editable: true,
    isBacktranslationConfigured: true,
    statisticalGloss: "",
    alignmentOpen: false,
    onAlignmentOpenChange: vi.fn(),
    alignmentModel: null,
    showAlignment: false,
    ...over,
  }
  return {
    ...render(
      <I18nProvider>
        <BacktranslationPanel {...props} />
      </I18nProvider>,
    ),
    props,
  }
}

describe("BacktranslationPanel", () => {
  it("offers Generate back-translation when there is a translation and no reading", () => {
    renderPanel()
    expect(screen.getByRole("button", { name: /generate back-translation/i })).toBeTruthy()
    // AQU-1408: the gloss is a section that is simply there, not an expander
    // the reader has to know to open.
    expect(screen.getByRole("heading", { name: /statistical gloss/i })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /statistical gloss/i })).toBeNull()
  })

  it("shows the statistical gloss before any AI back-translation exists", () => {
    renderPanel({ statisticalGloss: "house of him" })
    expect(screen.getByRole("heading", { name: /statistical gloss/i })).toBeTruthy()
    expect(screen.getByText("house of him")).toBeTruthy()
  })

  // AQU-1408 §3: the order is the point. The gloss is the project's own
  // evidence, so it must precede the AI reading in the document — a reader who
  // meets the smoothed AI reading first has already been anchored by it.
  it("puts the statistical gloss above the AI back-translation", () => {
    const { container } = renderPanel({
      statisticalGloss: "house of him",
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: true,
      }),
    })
    const glossHeading = screen.getByRole("heading", { name: /statistical gloss/i })
    const aiHeading = screen.getByText("AI back-translation")
    expect(
      glossHeading.compareDocumentPosition(aiHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(container).toBeTruthy()
  })

  // AQU-1408 §4: each view says what KIND of output it is, on screen, not in a
  // tooltip a reader has to discover by hovering.
  it("shows a visible descriptor for each of the two readings", () => {
    renderPanel({
      statisticalGloss: "house of him",
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: true,
      }),
    })
    expect(screen.getByText(/direct word-for-word translation/i)).toBeTruthy()
    expect(screen.getByText(/smoothed, re-worded reading/i)).toBeTruthy()
  })

  it("labels an AI back-translation and reassures when it still matches", () => {
    renderPanel({
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: true,
      }),
    })
    expect(screen.getByText("AI back-translation")).toBeTruthy()
    expect(screen.getByText("Matches this translation")).toBeTruthy()
    expect(screen.getByText("the house of him")).toBeTruthy()
  })

  it("still marks a hand-corrected reading as corrected", () => {
    renderPanel({
      cell: cell({
        backtranslation: "house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: false,
      }),
    })
    expect(screen.getByText("Hand-corrected")).toBeTruthy()
  })

  it("warns when the back-translation describes an earlier version", () => {
    renderPanel({
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: true,
      }),
      visibleTranslated: "maison grande",
    })
    expect(screen.getByText(/earlier version/i)).toBeTruthy()
    expect(screen.queryByText("Matches this translation")).toBeNull()
  })

  it("surfaces a statistical disagreement as a clue, not a collapsed afterthought", () => {
    const onSave = vi.fn()
    renderPanel({
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: true,
      }),
      statisticalGloss: "his house",
      onSaveBacktranslation: onSave,
    })
    expect(screen.getByText(/statistical gloss differs/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /use this gloss/i }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", translated: "maison de lui" }),
      "his house",
      false,
    )
  })

  it("lets a contributor correct the reading", () => {
    const onSave = vi.fn()
    renderPanel({
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: true,
      }),
      onSaveBacktranslation: onSave,
    })
    fireEvent.click(screen.getByRole("button", { name: "Edit the back-translation" }))
    const area = screen.getByRole("textbox")
    fireEvent.change(area, { target: { value: "house of him" } })
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1" }),
      "house of him",
      false,
    )
  })

  it("locks edit for reviewers", () => {
    renderPanel({
      editable: false,
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
      }),
    })
    expect(screen.getByLabelText("Contributor+ required to edit back-translations")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /generate back-translation/i })).toBeNull()
  })
})
