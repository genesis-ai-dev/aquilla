import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { PericopeSuggestions } from "./PericopeSuggestions"
import type { PericopeSuggestion } from "@/lib/pericope/suggest"

function suggestion(overrides: Partial<PericopeSuggestion> = {}): PericopeSuggestion {
  return {
    key: "GEN:1.1-2.3",
    book: "GEN",
    start: { chapter: 1, verse: 1 },
    end: { chapter: 2, verse: 3 },
    startRef: "GEN 1:1",
    endRef: "GEN 2:3",
    translations: 14,
    continuation: false,
    ...overrides,
  }
}

function renderSuggestions(
  suggestions: PericopeSuggestion[],
  onSelect = vi.fn(),
) {
  render(
    <I18nProvider>
      <PericopeSuggestions suggestions={suggestions} onSelect={onSelect} />
    </I18nProvider>,
  )
  return onSelect
}

describe("PericopeSuggestions", () => {
  it("stays off the toolbar entirely when there is nothing to suggest", () => {
    renderSuggestions([])
    expect(screen.queryByRole("button", { name: /suggested passages/i })).toBeNull()
  })

  it("names each range by book and shows how widely the boundary is agreed", async () => {
    const user = userEvent.setup()
    renderSuggestions([
      suggestion(),
      suggestion({ key: "GEN:1.1-1.31", end: { chapter: 1, verse: 31 }, endRef: "GEN 1:31", translations: 4 }),
    ])

    await user.click(screen.getByRole("button", { name: /suggested passages/i }))

    expect(screen.getByText("Genesis 1:1–2:3")).toBeInTheDocument()
    expect(screen.getByText("14 of 20 Bibles break here")).toBeInTheDocument()
    expect(screen.getByText("Genesis 1:1–1:31")).toBeInTheDocument()
    expect(screen.getByText("4 of 20 Bibles break here")).toBeInTheDocument()
  })

  it("says a clipped range finishes the passage instead of quoting an agreement count", async () => {
    const user = userEvent.setup()
    renderSuggestions([
      suggestion({ start: { chapter: 1, verse: 6 }, startRef: "GEN 1:6", continuation: true }),
    ])

    await user.click(screen.getByRole("button", { name: /suggested passages/i }))

    expect(screen.getByText("Finishes the passage you are in")).toBeInTheDocument()
    expect(screen.queryByText(/of 20 Bibles/)).toBeNull()
  })

  it("hands the chosen range back to the editor", async () => {
    const user = userEvent.setup()
    const chosen = suggestion()
    const onSelect = renderSuggestions([chosen])

    await user.click(screen.getByRole("button", { name: /suggested passages/i }))
    await user.click(screen.getByText("Genesis 1:1–2:3"))

    expect(onSelect).toHaveBeenCalledWith(chosen)
  })
})
