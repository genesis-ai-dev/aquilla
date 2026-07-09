import { fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { ViewSettingsMenu } from "./ViewSettingsMenu"

function renderViewSettings(overrides: Partial<ComponentProps<typeof ViewSettingsMenu>> = {}) {
  const noop = vi.fn()
  render(
    <ViewSettingsMenu
      fileOpen
      lineNumbersEnabled
      sourceDirectionMode="auto"
      targetDirectionMode="auto"
      sourceTextDirection="ltr"
      targetTextDirection="rtl"
      sourceAutoDirectionSummary="ltr"
      targetAutoDirectionSummary="rtl"
      cellLabelsEnabled
      tnSidebarEnabled={false}
      sourceFontSize={14}
      targetFontSize={14}
      onLineNumbersChange={noop}
      onSourceDirectionModeChange={noop}
      onTargetDirectionModeChange={noop}
      onCellLabelsChange={noop}
      onSourceFontSizeChange={noop}
      onTargetFontSizeChange={noop}
      onTnSidebarChange={noop}
      {...overrides}
    />,
  )
}

describe("ViewSettingsMenu direction display", () => {
  it("does not show a direction banner when Auto has already applied direction", () => {
    renderViewSettings()

    expect(screen.queryByRole("status")).toBeNull()
  })

  it("shows mixed target content in the settings menu", () => {
    renderViewSettings({ targetAutoDirectionSummary: "mixed" })

    fireEvent.click(screen.getByRole("button", { name: "View settings" }))

    expect(screen.getByText("AUTO MIXED")).toBeTruthy()
    expect(screen.queryByText("Detected right-to-left for target")).toBeNull()
  })
})
