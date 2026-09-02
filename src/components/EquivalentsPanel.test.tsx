import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
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
})
