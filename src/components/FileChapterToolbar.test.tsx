import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FileChapterToolbar } from "./FileChapterToolbar"

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
})

describe("FileChapterToolbar draft as you read", () => {
  it("omits Agent when the workspace does not offer its workbench", () => {
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
      />,
    )

    expect(screen.getByRole("tab", { name: "Text" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "Audio" })).toBeVisible()
    expect(screen.queryByRole("tab", { name: "Agent" })).toBeNull()
  })

  it("offers Agent beside the Text and Audio editor modes", async () => {
    const onAgentSelect = vi.fn()
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        onAgentSelect={onAgentSelect}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
      />,
    )

    expect(screen.getByRole("tab", { name: "Text" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "Audio" })).toBeVisible()
    await userEvent.click(screen.getByRole("tab", { name: "Agent" }))
    expect(onAgentSelect).toHaveBeenCalledOnce()
  })

  it("selects Agent when the workbench is showing and returns to Text on click", async () => {
    const onLensChange = vi.fn()
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={onLensChange}
        onAgentSelect={vi.fn()}
        agentActive
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
      />,
    )

    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "Text" })).toHaveAttribute("aria-selected", "false")
    await userEvent.click(screen.getByRole("tab", { name: "Text" }))
    expect(onLensChange).toHaveBeenCalledWith("text")
  })

  it("shows Text, Audio, and Agent labels beside the icons on larger screens", () => {
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        onAgentSelect={vi.fn()}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
      />,
    )

    expect(screen.getByRole("tab", { name: "Text" })).toHaveTextContent("Text")
    expect(screen.getByRole("tab", { name: "Audio" })).toHaveTextContent("Audio")
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveTextContent("Agent")
    expect(screen.getByRole("tab", { name: "Agent" }).querySelector("svg")).not.toBeNull()
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  it("keeps mode labels in quick tooltips on compact screens", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        onAgentSelect={vi.fn()}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
      />,
    )

    const textMode = screen.getByRole("tab", { name: "Text" })
    expect(textMode).toBeVisible()
    expect(textMode).not.toHaveTextContent("Text")
    await userEvent.hover(textMode)
    expect(await screen.findByRole("tooltip", { name: "Text" })).toBeVisible()
  })

  it("labels the read-along drafting mode \"Draft as you read\" in File options and reports the requested state", async () => {
    const onChange = vi.fn()
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
        translateAsReadEnabled={false}
        onTranslateAsReadChange={onChange}
      />,
    )

    expect(screen.queryByRole("switch", { name: "Draft as you read" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "File options" }))
    // AQU-1078: the old "Translate as read" label is gone for good.
    expect(screen.queryByRole("menuitemcheckbox", { name: "Translate as read" })).not.toBeInTheDocument()
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Draft as you read" })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("explains what Draft as you read does behind an info icon, and exposes it as the item's accessible description", async () => {
    const onChange = vi.fn()
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
        translateAsReadEnabled
        onTranslateAsReadChange={onChange}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "File options" }))
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Draft as you read" })
    // On/off state is carried by the checkbox role, so the mode-ness is
    // visible without extra copy.
    expect(toggle).toBeChecked()
    // The four guarantees from AQU-1078 reach assistive tech as the item's
    // description, never as part of its name.
    const help = "While on, AI drafts empty cells as you scroll and refreshes existing AI drafts when better validated examples appear. Every draft needs human review. Cells a person translated are never touched."
    expect(toggle).toHaveAccessibleName("Draft as you read")
    expect(toggle).toHaveAccessibleDescription(help)
    // Sighted users get the same text from the info icon at the end of the
    // row: hover shows it, and clicking the icon must not flip the toggle.
    const hint = toggle.querySelector("[data-slot=tooltip-trigger]") as HTMLElement
    expect(hint).not.toBeNull()
    await userEvent.hover(hint)
    expect(await screen.findByRole("tooltip", { name: help })).toBeVisible()
    await userEvent.click(hint)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("keeps Draft as you read disabled in File options when unavailable", async () => {
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={vi.fn()}
        menuItems={[]}
        translateAsReadDisabled
        onTranslateAsReadChange={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "File options" }))
    expect(screen.getByRole("menuitemcheckbox", { name: "Draft as you read" })).toHaveAttribute("aria-disabled", "true")
  })

  it("moves Check file into File options as a stateful item", async () => {
    const onCheckToggle = vi.fn()
    render(
      <FileChapterToolbar
        lens="text"
        onLensChange={vi.fn()}
        checkOpen={false}
        checkRunning={false}
        checkResult={null}
        onCheckToggle={onCheckToggle}
        menuItems={[]}
      />,
    )

    expect(screen.queryByTestId("check-file-button")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "File options" }))
    const checkFile = screen.getByRole("menuitemcheckbox", { name: "Check file" })
    expect(checkFile).not.toBeChecked()
    await userEvent.click(checkFile)
    expect(onCheckToggle).toHaveBeenCalledOnce()
  })
})

/**
 * AQU-1422: the file header's hidden-cell indicator.
 *
 * Count and reveal are ONE control because they answer one question — the thing
 * that tells you something is parked is the thing that shows it to you, rather
 * than a badge here and a switch three menus away.
 *
 * The workspace hands the prop over only to someone who may park cells, and only
 * when the count is above zero, so there is no permission check and no zero state
 * inside the component. The `hiddenCells` prop being ABSENT is therefore the
 * reader's case as well as the nothing-hidden case, and both are asserted.
 */
describe("FileChapterToolbar hidden-cell indicator (AQU-1422)", () => {
  const base = {
    lens: "text" as const,
    onLensChange: vi.fn(),
    checkOpen: false,
    checkRunning: false,
    checkResult: null,
    onCheckToggle: vi.fn(),
    menuItems: [],
  }

  it("is absent when nothing is hidden, or the reader may not park cells", () => {
    render(<FileChapterToolbar {...base} />)
    expect(screen.queryByTestId("hidden-cells-indicator")).toBeNull()
  })

  it("states the count and reads as not revealed", () => {
    render(
      <FileChapterToolbar
        {...base}
        hiddenCells={{ count: 3, revealed: false, onRevealedChange: vi.fn() }}
      />,
    )

    const btn = screen.getByTestId("hidden-cells-indicator")
    expect(btn.textContent).toContain("3 hidden")
    // Exposed as state, not as a colour class: the two appearances differ only by
    // tint, and asserting on the class would pin the styling rather than this.
    expect(btn).toHaveAttribute("data-revealed", "false")
    expect(btn).toHaveAttribute("aria-pressed", "false")
  })

  it("turns the reveal on and off from the same control", async () => {
    const onRevealedChange = vi.fn()
    const { rerender } = render(
      <FileChapterToolbar
        {...base}
        hiddenCells={{ count: 1, revealed: false, onRevealedChange }}
      />,
    )

    await userEvent.click(screen.getByTestId("hidden-cells-indicator"))
    expect(onRevealedChange).toHaveBeenCalledWith(true)

    rerender(
      <FileChapterToolbar
        {...base}
        hiddenCells={{ count: 1, revealed: true, onRevealedChange }}
      />,
    )
    const btn = screen.getByTestId("hidden-cells-indicator")
    expect(btn).toHaveAttribute("data-revealed", "true")
    expect(btn).toHaveAttribute("aria-pressed", "true")

    await userEvent.click(btn)
    expect(onRevealedChange).toHaveBeenLastCalledWith(false)
  })

  it("keeps the count singular-correct", () => {
    render(
      <FileChapterToolbar
        {...base}
        hiddenCells={{ count: 1, revealed: false, onRevealedChange: vi.fn() }}
      />,
    )
    expect(screen.getByTestId("hidden-cells-indicator").textContent).toContain("1 hidden")
  })
})
