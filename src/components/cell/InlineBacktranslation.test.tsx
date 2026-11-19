import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { InlineBacktranslation } from "./InlineBacktranslation"
import { draftingSettingsProblem, readDraftingSettings } from "../../../db/shared/drafting-settings"

function renderLine(props: Partial<Parameters<typeof InlineBacktranslation>[0]> = {}) {
  return render(
    <I18nProvider>
      <InlineBacktranslation reading={undefined} stale={false} generating={false} {...props} />
    </I18nProvider>,
  )
}

describe("InlineBacktranslation", () => {
  it("renders nothing without a reading or one in progress", () => {
    const { container } = renderLine()
    expect(container.querySelector("[data-testid=inline-backtranslation]")).toBeNull()
  })

  it("shows a current reading as plain text", () => {
    renderLine({ reading: "in beginning God made" })
    const line = screen.getByTestId("inline-backtranslation")
    expect(line.getAttribute("data-state")).toBe("current")
    expect(line.textContent).toContain("in beginning God made")
    expect(line.textContent).not.toContain("Out of date")
  })

  it("marks a reading of older text as out of date", () => {
    renderLine({ reading: "in beginning God made", stale: true })
    expect(screen.getByTestId("inline-backtranslation").getAttribute("data-state")).toBe("stale")
    expect(screen.getByText("Out of date")).toBeTruthy()
  })

  it("says it is back-translating when there is no reading yet", () => {
    renderLine({ generating: true })
    expect(screen.getByTestId("inline-backtranslation").textContent).toContain("Back-translating…")
  })

  it("keeps the old reading on screen while a new one is made", () => {
    renderLine({ reading: "old reading", stale: true, generating: true })
    const line = screen.getByTestId("inline-backtranslation")
    expect(line.getAttribute("data-state")).toBe("generating")
    expect(line.textContent).toContain("old reading")
    expect(line.textContent).not.toContain("Out of date")
  })

  it("says a reading failed, with the reason on hover", () => {
    renderLine({ error: 'Model "x" is not available on this platform.' })
    const line = screen.getByTestId("inline-backtranslation")
    expect(line.getAttribute("data-state")).toBe("failed")
    expect(line.textContent).toContain("Back-translation failed")
    expect(line.getAttribute("title")).toContain("not available")
  })

  it("keeps the last reading when a refresh fails", () => {
    renderLine({ reading: "old reading", stale: true, error: "no credits" })
    const line = screen.getByTestId("inline-backtranslation")
    expect(line.textContent).toContain("old reading")
    expect(line.textContent).toContain("Back-translation failed")
    expect(line.textContent).not.toContain("Out of date")
  })

  it("opens the back-translation without reaching the row", () => {
    const onOpen = vi.fn()
    const onRow = vi.fn()
    render(
      <I18nProvider>
        <div onClick={onRow}>
          <InlineBacktranslation reading="x" stale={false} generating={false} onOpen={onOpen} />
        </div>
      </I18nProvider>,
    )
    fireEvent.click(screen.getByTestId("inline-backtranslation"))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onRow).not.toHaveBeenCalled()
  })
})

describe("drafting settings: live back-translation fields", () => {
  it("accepts the two new fields", () => {
    expect(draftingSettingsProblem({ liveBacktranslation: true, backtranslationModel: "bt/model" })).toBeNull()
  })

  it("refuses malformed values and drops them on read", () => {
    expect(draftingSettingsProblem({ liveBacktranslation: "yes" })).toMatch(/true or false/)
    expect(readDraftingSettings({ liveBacktranslation: "yes", backtranslationModel: "m" })).toEqual({ backtranslationModel: "m" })
  })
})
