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
  it("renders an obvious switch and reports the requested state", async () => {
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

    const toggle = screen.getByRole("switch", { name: "Translate as read" })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText("Translate as read")).toBeVisible()
    await userEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true, expect.anything())
  })

  it("disables activation when translation is unavailable", () => {
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

    expect(screen.getByRole("switch", { name: "Translate as read" })).toHaveAttribute("aria-disabled", "true")
  })
})
