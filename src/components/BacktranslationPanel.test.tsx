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
  it("offers Read it back with AI when there is a translation and no reading", () => {
    renderPanel()
    expect(screen.getByRole("button", { name: /read it back with AI/i })).toBeTruthy()
    expect(screen.getByRole("button", { name: /statistical gloss/i })).toBeTruthy()
  })

  it("shows a live project-pairs gloss before any AI reading exists", () => {
    renderPanel({ statisticalGloss: "house of him" })
    expect(screen.getByText(/updates as you translate/i)).toBeTruthy()
    expect(screen.getByText("house of him")).toBeTruthy()
  })

  it("labels an AI reading and reassures when it still matches", () => {
    renderPanel({
      cell: cell({
        backtranslation: "the house of him",
        backtranslationForText: "maison de lui",
        backtranslationPolished: true,
      }),
    })
    expect(screen.getByText("AI reading")).toBeTruthy()
    expect(screen.getByText("Matches this translation")).toBeTruthy()
    expect(screen.getByText("the house of him")).toBeTruthy()
  })

  it("warns when the reading describes an earlier version", () => {
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
    expect(screen.getByText(/pairs read it differently/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /use this reading/i }))
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
    expect(screen.queryByRole("button", { name: /read it back/i })).toBeNull()
  })
})
