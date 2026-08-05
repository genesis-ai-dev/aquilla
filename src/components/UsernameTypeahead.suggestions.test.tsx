// Multi-select typeahead extensions for the member-add surfaces:
//   - `suggestions` (eligible org colleagues) render as checkbox rows on
//     focus, before any search, and merge dedup'd with search results.
//   - A settled search miss in multi-select mode offers an actionable
//     "Add by exact username" row — the scoped search (AQU-321) can't see
//     out-of-scope users, so a miss must not dead-end the add.
//   - Scoped multi-select miss copy doesn't claim the account doesn't exist.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"
import { UsernameTypeahead, type RecipientValue } from "./UsernameTypeahead"

// Echo the query so searchMatchesInput passes; "bob" is findable, everything
// else misses with a settled OK fetch.
vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: (query: string) => {
    const all = [{ id: 12, username: "bob" }]
    const q = query.trim().toLowerCase()
    const results = q.length >= 2 ? all.filter((u) => u.username.toLowerCase().includes(q)) : []
    return { query, results, isLoading: false, needsMorePrefix: q.length < 2, lastFetchOk: true }
  },
}))

function Harness({
  multiSelect,
  suggestions,
  emptySuggestionsHint,
  scopedSearch,
  onStageTyped = () => {},
  onToggleResult = () => {},
}: {
  multiSelect: boolean
  suggestions?: Array<{ id: number; username: string }>
  emptySuggestionsHint?: string
  scopedSearch?: boolean
  onStageTyped?: () => void
  onToggleResult?: (u: { id: number; username: string }) => void
}) {
  const [value, setValue] = useState<RecipientValue>({ mode: "username", raw: "" })
  return (
    <UsernameTypeahead
      value={value}
      onChange={setValue}
      showModeToggle={false}
      suggestions={suggestions}
      emptySuggestionsHint={emptySuggestionsHint}
      scopedSearch={scopedSearch}
      multiSelect={
        multiSelect
          ? { stagedUsernames: new Set(), onToggleResult, onStageTyped }
          : undefined
      }
    />
  )
}

function input() {
  return screen.getByPlaceholderText("Aquilla username")
}

describe("UsernameTypeahead — suggestions + settled-miss staging", () => {
  it("renders suggestions as checkbox rows on focus before anything is typed", () => {
    render(
      <Harness
        multiSelect
        suggestions={[
          { id: 5, username: "dana" },
          { id: 6, username: "dave" },
        ]}
      />,
    )
    fireEvent.focus(input())
    expect(screen.getByRole("checkbox", { name: "dana" })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "dave" })).toBeInTheDocument()
  })

  it("merges suggestions with search results without duplicating a person", () => {
    // bob is both an eligible suggestion AND a search hit for "bo".
    render(<Harness multiSelect suggestions={[{ id: 12, username: "bob" }]} />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: "bo" } })
    expect(screen.getAllByRole("checkbox", { name: "bob" })).toHaveLength(1)
  })

  it("shows the empty-suggestions hint when provided and no one is eligible", () => {
    render(
      <Harness
        multiSelect
        suggestions={[]}
        emptySuggestionsHint="All org members already have access."
      />,
    )
    fireEvent.focus(input())
    expect(screen.getByText("All org members already have access.")).toBeInTheDocument()
  })

  it("offers 'Add by exact username' on a settled scoped miss and stages the typed name", () => {
    const onStageTyped = vi.fn()
    render(<Harness multiSelect scopedSearch onStageTyped={onStageTyped} />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: "zed" } })

    // Scoped copy must not claim the account doesn't exist (AQU-321 scoping).
    expect(
      screen.getByText(/no match among people who share an org or project with you/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/no aquilla user named/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /add "zed" by exact username/i }))
    expect(onStageTyped).toHaveBeenCalledTimes(1)
  })

  it("keeps the definitive miss copy and no staging action in single-pick mode", () => {
    render(<Harness multiSelect={false} scopedSearch />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: "zed" } })

    expect(screen.getByText(/no aquilla user named "zed"/i)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /by exact username/i }),
    ).not.toBeInTheDocument()
  })
})

describe("UsernameTypeahead — dropdown placement", () => {
  function mockInputRect(rect: { top: number; bottom: number }) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: rect.top,
      left: 40,
      right: 440,
      width: 400,
      height: rect.bottom - rect.top,
      top: rect.top,
      bottom: rect.bottom,
      toJSON: () => ({}),
    } as DOMRect)
  }

  function dropdown(): HTMLElement {
    // The portal container is the fixed-positioned ancestor of a known row.
    const el = screen.getByRole("checkbox", { name: "dana" }).closest(".fixed")
    expect(el).not.toBeNull()
    return el as HTMLElement
  }

  const SUGGESTIONS = [{ id: 5, username: "dana" }]

  it("opens below the field when there is room underneath", () => {
    mockInputRect({ top: 100, bottom: 132 })
    render(<Harness multiSelect suggestions={SUGGESTIONS} />)
    fireEvent.focus(input())

    expect(dropdown().style.top).toBe("136px")
    expect(dropdown().style.bottom).toBe("")
  })

  it("flips above the field when the viewport would cut it off below", () => {
    // Field hugs the viewport bottom (happy-dom window.innerHeight = 768):
    // 20px below < the 184px the dropdown may need, plenty of room above.
    mockInputRect({ top: 716, bottom: 748 })
    render(<Harness multiSelect suggestions={SUGGESTIONS} />)
    fireEvent.focus(input())

    expect(dropdown().style.bottom).toBe(`${window.innerHeight - 716 + 4}px`)
    expect(dropdown().style.top).toBe("")
  })
})
