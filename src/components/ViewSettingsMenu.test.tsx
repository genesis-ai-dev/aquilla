import { fireEvent, render, screen, within } from "@testing-library/react"
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

describe("ViewSettingsMenu popover", () => {
  it("opens as a popover and toggles line numbers without dismissing", () => {
    const handlers = renderViewSettings({ lineNumbersEnabled: true })

    fireEvent.click(screen.getByRole("button", { name: "View settings" }))

    const panel = screen.getByTestId("view-settings-popover")
    expect(panel).toBeTruthy()
    expect(screen.getByText("Show line numbers")).toBeTruthy()
    expect(screen.getByText("Show cell labels")).toBeTruthy()
    expect(screen.getByText("Text Direction")).toBeTruthy()
    expect(screen.getByText("Font Size")).toBeTruthy()

    fireEvent.click(screen.getByRole("switch", { name: /Show line numbers/i }))
    expect(handlers.onLineNumbersChange).toHaveBeenCalledWith(false)
    expect(screen.getByTestId("view-settings-popover")).toBeTruthy()
  })

  it("changes source direction via the tabs", () => {
    const handlers = renderViewSettings()

    fireEvent.click(screen.getByRole("button", { name: "View settings" }))
    const sourceTabs = screen.getByRole("tablist", { name: "Source direction" })
    fireEvent.click(within(sourceTabs).getByRole("tab", { name: "RTL" }))

    expect(handlers.onSourceDirectionModeChange).toHaveBeenCalledWith("rtl")
  })
})

describe("ViewSettingsMenu direction display", () => {
  it("does not show a direction banner when Auto has already applied direction", () => {
    renderViewSettings()

    expect(screen.queryByRole("status")).toBeNull()
  })

  it("opens direction tabs without a resolved-direction badge", () => {
    renderViewSettings({ targetAutoDirectionSummary: "mixed" })

    fireEvent.click(screen.getByRole("button", { name: "View settings" }))

    expect(screen.getByRole("tablist", { name: "Target direction" })).toBeTruthy()
    expect(screen.queryByText("AUTO MIXED")).toBeNull()
    expect(screen.queryByText("Detected right-to-left for target")).toBeNull()
  })

  it("warns when target is forced LTR but content is RTL", () => {
    const handlers = renderViewSettings({
      targetDirectionMode: "ltr",
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
      targetAutoDirectionSummary: "rtl",
    })

    expect(screen.queryByRole("status")).toBeNull()
  })
})
