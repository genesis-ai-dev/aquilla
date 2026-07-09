import { fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { ViewSettingsMenu } from "./ViewSettingsMenu"

function renderViewSettings(overrides: Partial<ComponentProps<typeof ViewSettingsMenu>> = {}) {
  const handlers = {
    onLineNumbersChange: vi.fn(),
    onSourceDirectionModeChange: vi.fn(),
    onTargetDirectionModeChange: vi.fn(),
    onCellLabelsChange: vi.fn(),
    onSourceFontSizeChange: vi.fn(),
    onTargetFontSizeChange: vi.fn(),
    onTnSidebarChange: vi.fn(),
  }
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
      {...handlers}
      {...overrides}
    />,
  )
  return handlers
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

  it("warns when target is forced LTR but content is RTL", () => {
    const handlers = renderViewSettings({
      targetDirectionMode: "ltr",
      targetTextDirection: "ltr",
      targetAutoDirectionSummary: "rtl",
    })

    const warning = screen.getByRole("status")
    expect(warning.textContent).toContain("Target is forced left-to-right")
    expect(warning.textContent).toContain("content looks right-to-left")

    fireEvent.click(screen.getByRole("button", { name: "RTL" }))

    expect(handlers.onTargetDirectionModeChange).toHaveBeenCalledWith("rtl")
  })

  it("warns when source is forced RTL but content is LTR", () => {
    const handlers = renderViewSettings({
      sourceDirectionMode: "rtl",
      sourceTextDirection: "rtl",
      sourceAutoDirectionSummary: "ltr",
      targetAutoDirectionSummary: "rtl",
    })

    const warning = screen.getByRole("status")
    expect(warning.textContent).toContain("Source is forced right-to-left")
    expect(warning.textContent).toContain("content looks left-to-right")

    fireEvent.click(screen.getByRole("button", { name: "LTR" }))

    expect(handlers.onSourceDirectionModeChange).toHaveBeenCalledWith("ltr")
  })

  it("offers Auto for mixed content under a manual direction", () => {
    const handlers = renderViewSettings({
      targetDirectionMode: "rtl",
      targetTextDirection: "rtl",
      targetAutoDirectionSummary: "mixed",
    })

    const warning = screen.getByRole("status")
    expect(warning.textContent).toContain("Target is forced right-to-left")
    expect(warning.textContent).toContain("content looks mixed")
    expect(screen.queryByRole("button", { name: "LTR" })).toBeNull()
    expect(screen.queryByRole("button", { name: "RTL" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Auto" }))

    expect(handlers.onTargetDirectionModeChange).toHaveBeenCalledWith("auto")
  })

  it("does not warn when a manual direction matches the content", () => {
    renderViewSettings({
      targetDirectionMode: "rtl",
      targetTextDirection: "rtl",
      targetAutoDirectionSummary: "rtl",
    })

    expect(screen.queryByRole("status")).toBeNull()
  })
})
