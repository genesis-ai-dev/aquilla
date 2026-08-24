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

describe("FileChapterToolbar translate as read", () => {
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

  it("keeps mode labels in quick tooltips instead of visible text", async () => {
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

  it("moves Translate as read into File options and reports the requested state", async () => {
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

    expect(screen.queryByRole("switch", { name: "Translate as read" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "File options" }))
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Translate as read" })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("keeps Translate as read disabled in File options when unavailable", async () => {
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
    expect(screen.getByRole("menuitemcheckbox", { name: "Translate as read" })).toHaveAttribute("aria-disabled", "true")
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
