import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast, Toaster } from "@/components/ui/toast"
import {
  getMilestoneSplit,
  resetMilestoneSplitCacheForTests,
  setMilestoneSplit,
} from "@/lib/store/milestone-split-pref"
import {
  getUnresolvedCommentHighlight,
  resetUnresolvedCommentHighlightCacheForTests,
  setUnresolvedCommentHighlight,
} from "@/lib/store/unresolved-comment-highlight-pref"
import { DIRECTION_MISMATCH_TOAST_ID, ViewSettingsMenu } from "./ViewSettingsMenu"

function renderViewSettings(overrides: Partial<ComponentProps<typeof ViewSettingsMenu>> = {}) {
  const handlers = {
    onLineNumbersChange: vi.fn(),
    onSourceDirectionModeChange: vi.fn(),
    onTargetDirectionModeChange: vi.fn(),
    onCellLabelsChange: vi.fn(),
    onSourceFontSizeChange: vi.fn(),
    onTargetFontSizeChange: vi.fn(),
    onSourceFontSizeReset: vi.fn(),
    onTargetFontSizeReset: vi.fn(),
    onTnSidebarChange: vi.fn(),
    onTargetKeyTermHighlightModeChange: vi.fn(),
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
        targetKeyTermHighlightMode="never"
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

beforeEach(() => {
  localStorage.clear()
  resetMilestoneSplitCacheForTests()
  setMilestoneSplit(false)
  resetUnresolvedCommentHighlightCacheForTests()
  setUnresolvedCommentHighlight(false)
})

afterEach(() => {
  toast.close(DIRECTION_MISMATCH_TOAST_ID)
})

describe("ViewSettingsMenu popover", () => {
  it("opens as a popover and toggles line numbers without dismissing", () => {
    const handlers = renderViewSettings({ lineNumbersEnabled: true })

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))

    const panel = screen.getByTestId("view-settings-popover")
    expect(panel).toBeTruthy()
    expect(screen.getByRole("switch", { name: "Split into milestones" })).toBeTruthy()
    expect(screen.getByText("Show line numbers")).toBeTruthy()
    expect(screen.getByText("Show cell labels")).toBeTruthy()
    expect(screen.getByText("Target key terms")).toBeTruthy()
    expect(screen.getByText("Text Direction")).toBeTruthy()
    expect(screen.getByText("Font Size")).toBeTruthy()

    fireEvent.click(screen.getByRole("switch", { name: /Show line numbers/i }))
    expect(handlers.onLineNumbersChange).toHaveBeenCalledWith(false)
    expect(screen.getByTestId("view-settings-popover")).toBeTruthy()
  })

  it("toggles split-into-milestones and keeps the popover open", () => {
    renderViewSettings()

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    const toggle = screen.getByRole("switch", { name: "Split into milestones" })
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)

    expect(screen.getByRole("switch", { name: "Split into milestones" })).toBeChecked()
    expect(getMilestoneSplit()).toBe(true)
    expect(screen.getByTestId("view-settings-popover")).toBeTruthy()
  })

  it("changes when target key terms are highlighted", () => {
    const handlers = renderViewSettings()

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    const targetTermOptions = screen.getByRole("radiogroup", { name: "Target key terms" })
    fireEvent.click(within(targetTermOptions).getByRole("radio", { name: "Focused cell only" }))

    expect(handlers.onTargetKeyTermHighlightModeChange).toHaveBeenCalledWith("focused")
  })

  it("changes source direction via the tabs", () => {
    const handlers = renderViewSettings()

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    const sourceTabs = screen.getByRole("tablist", { name: "Source direction" })
    fireEvent.click(within(sourceTabs).getByRole("tab", { name: "RTL" }))

    expect(handlers.onSourceDirectionModeChange).toHaveBeenCalledWith("rtl")
  })

  it("steps font size from the scaled Large default (AQU-1170)", () => {
    const handlers = renderViewSettings({ sourceFontSize: 16, targetFontSize: 16 })

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    expect(screen.getAllByText("16px")).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Increase target font size" }))
    expect(handlers.onTargetFontSizeChange).toHaveBeenCalledWith(17)

    fireEvent.click(screen.getByRole("button", { name: "Decrease source font size" }))
    expect(handlers.onSourceFontSizeChange).toHaveBeenCalledWith(15)
    expect(screen.queryByRole("button", { name: "Use app font size for target" })).toBeNull()
  })

  it("steps font size from the Small scaled default (AQU-1170)", () => {
    const handlers = renderViewSettings({ sourceFontSize: 12, targetFontSize: 12 })
    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    fireEvent.click(screen.getByRole("button", { name: "Increase target font size" }))
    expect(handlers.onTargetFontSizeChange).toHaveBeenCalledWith(13)
  })

  it("steps Extra Large scaled default and resets a pinned column to the app size", () => {
    const handlers = renderViewSettings({
      sourceFontSize: 18,
      targetFontSize: 19,
      targetFontSizeExplicit: true,
    })

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    expect(screen.getByText("18px")).toBeTruthy()
    expect(screen.getByText("19px")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Increase source font size" }))
    expect(handlers.onSourceFontSizeChange).toHaveBeenCalledWith(19)

    fireEvent.click(screen.getByRole("button", { name: "Use app font size for target" }))
    expect(handlers.onTargetFontSizeReset).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "Use app font size for source" })).toBeNull()
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

// AQU-1259 (B): the reviewer's opt-in scanning view lives beside the other
// editor view toggles and is a device preference, like the milestone split.
describe("ViewSettingsMenu — highlight open comments", () => {
  it("offers the toggle off by default and stores the opt-in", () => {
    renderViewSettings()

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    const toggle = screen.getByRole("switch", { name: "Highlight open comments" })
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(getUnresolvedCommentHighlight()).toBe(false)

    fireEvent.click(toggle)

    expect(getUnresolvedCommentHighlight()).toBe(true)
    expect(
      screen.getByRole("switch", { name: "Highlight open comments" }).getAttribute("aria-checked"),
    ).toBe("true")
  })

  it("renders on from a stored preference and turns back off", () => {
    setUnresolvedCommentHighlight(true)
    renderViewSettings()

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))
    const toggle = screen.getByRole("switch", { name: "Highlight open comments" })
    expect(toggle.getAttribute("aria-checked")).toBe("true")

    fireEvent.click(toggle)

    expect(getUnresolvedCommentHighlight()).toBe(false)
  })

  it("is disabled with no file open, since there are no rows to mark", () => {
    renderViewSettings({ fileOpen: false })

    fireEvent.click(screen.getByRole("button", { name: "Editor settings" }))

    const toggle = screen.getByRole("switch", { name: "Highlight open comments" })
    expect(toggle.getAttribute("aria-disabled")).toBe("true")

    fireEvent.click(toggle)

    expect(getUnresolvedCommentHighlight()).toBe(false)
  })
})
