import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast, Toaster } from "@/components/ui/toast"
import { DIRECTION_MISMATCH_TOAST_ID, ViewSettingsMenu } from "./ViewSettingsMenu"

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
    <>
      <Toaster />
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
      />
    </>,
  )
  return handlers
}

function directionWarning() {
  return screen.getByRole("dialog", { name: /is forced/i })
}

afterEach(() => {
  toast.close(DIRECTION_MISMATCH_TOAST_ID)
})

describe("ViewSettingsMenu popover", () => {
  it("opens as a popover and toggles line numbers without dismissing", () => {
    const handlers = renderViewSettings({ lineNumbersEnabled: true })

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))

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

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    const sourceTabs = screen.getByRole("tablist", { name: "Source direction" })
    fireEvent.click(within(sourceTabs).getByRole("tab", { name: "RTL" }))

    expect(handlers.onSourceDirectionModeChange).toHaveBeenCalledWith("rtl")
  })
})

describe("ViewSettingsMenu direction display", () => {
  it("does not show a direction toast when Auto has already applied direction", () => {
    renderViewSettings()

    expect(screen.queryByRole("dialog", { name: /is forced/i })).toBeNull()
  })

  it("opens direction tabs without a resolved-direction badge", () => {
    renderViewSettings({ targetAutoDirectionSummary: "mixed" })

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))

    expect(screen.getByRole("tablist", { name: "Target direction" })).toBeTruthy()
    expect(screen.queryByText("AUTO MIXED")).toBeNull()
    expect(screen.queryByText("Detected right-to-left for target")).toBeNull()
  })

  it("warns when target is forced LTR but content is RTL", () => {
    const handlers = renderViewSettings({
      targetDirectionMode: "ltr",
      targetAutoDirectionSummary: "rtl",
    })

    const warning = directionWarning()
    expect(warning.textContent).toContain("Target is forced left-to-right")
    expect(warning.textContent).toContain("content looks right-to-left")

    fireEvent.click(within(warning).getByRole("button", { name: "Auto" }))

    expect(handlers.onTargetDirectionModeChange).toHaveBeenCalledWith("auto")
  })

  it("warns when source is forced RTL but content is LTR", () => {
    const handlers = renderViewSettings({
      sourceDirectionMode: "rtl",
      sourceAutoDirectionSummary: "ltr",
      targetAutoDirectionSummary: "rtl",
    })

    const warning = directionWarning()
    expect(warning.textContent).toContain("Source is forced right-to-left")
    expect(warning.textContent).toContain("content looks left-to-right")

    fireEvent.click(within(warning).getByRole("button", { name: "Auto" }))

    expect(handlers.onSourceDirectionModeChange).toHaveBeenCalledWith("auto")
  })

  it("offers Auto for mixed content under a manual direction", () => {
    const handlers = renderViewSettings({
      targetDirectionMode: "rtl",
      targetAutoDirectionSummary: "mixed",
    })

    const warning = directionWarning()
    expect(warning.textContent).toContain("Target is forced right-to-left")
    expect(warning.textContent).toContain("content looks mixed")
    expect(within(warning).queryByRole("button", { name: "LTR" })).toBeNull()
    expect(within(warning).queryByRole("button", { name: "RTL" })).toBeNull()

    fireEvent.click(within(warning).getByRole("button", { name: "Auto" }))

    expect(handlers.onTargetDirectionModeChange).toHaveBeenCalledWith("auto")
  })

  it("does not warn when a manual direction matches the content", () => {
    renderViewSettings({
      targetDirectionMode: "rtl",
      targetAutoDirectionSummary: "rtl",
    })

    expect(screen.queryByRole("dialog", { name: /is forced/i })).toBeNull()
  })

  it("emphasises the two conflicting directions inside the warning", () => {
    // The warning exists to contrast what was FORCED with what was DETECTED, and
    // the emphasis is what lets a reader see the conflict without parsing the
    // line. Keying the sentence as one catalog string flattened both <strong>s
    // once already, so assert the ELEMENTS: a text-only assertion passes on the
    // flattened version and would not have caught it.
    renderViewSettings({
      targetDirectionMode: "ltr",
      targetAutoDirectionSummary: "rtl",
    })

    const warning = directionWarning()
    const emphasised = [...warning.querySelectorAll("strong")].map((el) => el.textContent)
    expect(emphasised).toEqual(["left-to-right", "right-to-left"])
    // …and the sentence around them is still one translated string.
    expect(warning.textContent).toContain("Target is forced left-to-right")
    expect(warning.textContent).toContain("content looks right-to-left")
  })

  it("keeps the mismatch toast visible while editor settings are open", () => {
    renderViewSettings({
      targetDirectionMode: "ltr",
      targetAutoDirectionSummary: "rtl",
    })

    expect(directionWarning().textContent).toContain("Target is forced left-to-right")

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))

    expect(directionWarning().textContent).toContain("Target is forced left-to-right")
  })

  it("dismissing the toast does not change the manual direction", async () => {
    const handlers = renderViewSettings({
      targetDirectionMode: "ltr",
      targetAutoDirectionSummary: "rtl",
    })

    const close = directionWarning().querySelector('[data-slot="toast-close"]')
    expect(close).toBeTruthy()
    fireEvent.click(close!)

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /is forced/i })).toBeNull()
    })
    expect(handlers.onTargetDirectionModeChange).not.toHaveBeenCalled()
    expect(handlers.onSourceDirectionModeChange).not.toHaveBeenCalled()
  })
})
