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

  it("explains what Draft as you read does, as visible copy and as the item's accessible description", async () => {
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
        onTranslateAsReadChange={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "File options" }))
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Draft as you read" })
    // On/off state is carried by the checkbox role, so the mode-ness is
    // visible without extra copy.
    expect(toggle).toBeChecked()
    // The four guarantees from AQU-1078, on the item itself rather than a
    // hover tooltip.
    const help = "While on, AI drafts empty cells as you scroll and refreshes existing AI drafts when better validated examples appear. Every draft needs human review. Cells a person translated are never touched."
    expect(toggle).toHaveTextContent(help)
    expect(toggle).toHaveAccessibleDescription(help)
    expect(toggle).toHaveAccessibleName("Draft as you read")
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
