import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { EquivalentsPanel } from "./EquivalentsPanel"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"
import type { PredictedEquivalent } from "@/lib/terminology/equivalents"

const PREDICTION: PredictedEquivalent = {
  target: "dios",
  source: "both",
  confidence: "HIGH",
  confidenceScore: 0.67,
  chi2: 294.6,
  emProb: 0.01,
  examples: [{ source: "God is good", target: "Dios es bueno" }],
}

const LOWER_CONFIDENCE_PREDICTION: PredictedEquivalent = {
  ...PREDICTION,
  target: "señor",
  confidenceScore: 0.42,
}

function prediction(target: string, confidenceScore: number): PredictedEquivalent {
  return { ...PREDICTION, target, confidenceScore }
}

afterEach(() => {
  cleanup()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

function renderPanel(locale = "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  return render(
    <I18nProvider>
      <EquivalentsPanel
        sourceTerm="God"
        managed={[]}
        predicted={[PREDICTION]}
      />
    </I18nProvider>,
  )
}

function renderPredictions(predicted: PredictedEquivalent[]) {
  return render(
    <I18nProvider>
      <EquivalentsPanel sourceTerm="God" managed={[]} predicted={predicted} />
    </I18nProvider>,
  )
}

describe("EquivalentsPanel", () => {
  it("shows one user-facing confidence label without statistical diagnostics", () => {
    renderPanel()

    expect(screen.getByText("67% confidence")).toBeInTheDocument()
    expect(screen.getByText("Suggested translations")).toBeInTheDocument()
    expect(screen.queryByText(/χ²|EM|p=|HIGH/)).not.toBeInTheDocument()
  })

  it("localizes the confidence label and percentage", () => {
    renderPanel("ar")

    expect(
      screen.getByText((text) => text.replaceAll("\u200e", "") === "ثقة 67%"),
    ).toBeInTheDocument()
  })

  it("orders suggestions by the confidence users see", () => {
    renderPredictions([LOWER_CONFIDENCE_PREDICTION, PREDICTION])

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "dios",
      "señor",
    ])
  })

  it("shows the top three suggestions until the list is expanded", () => {
    renderPredictions([
      prediction("one", 0.9),
      prediction("two", 0.8),
      prediction("three", 0.7),
      prediction("four", 0.6),
      prediction("five", 0.5),
    ])

    expect(screen.getByRole("button", { name: "one" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "three" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "four" })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /show more/i }))

    expect(screen.getByRole("button", { name: "four" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "five" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument()
  })

  it("keeps the compact Add action at the end of each row", () => {
    const onPromote = vi.fn()
    render(
      <I18nProvider>
        <EquivalentsPanel
          sourceTerm="God"
          managed={[]}
          predicted={[PREDICTION]}
          canPromote
          onPromote={onPromote}
        />
      </I18nProvider>,
    )

    const add = screen.getByRole("button", { name: "Add" })
    expect(add).toHaveClass("ms-auto", "h-6", "text-[10px]")
    fireEvent.click(add)
    expect(onPromote).toHaveBeenCalledWith("dios")
  })
})
