// Multi-select typeahead extensions for the member-add surfaces:
//   - `suggestions` (eligible org colleagues) render as checkbox rows on
//     focus, before any search, and merge dedup'd with search results.
//   - A settled search miss resolves the exact typed username against the
//     unscoped lookup (AQU-781): the scoped search (AQU-321) can't see
//     out-of-scope users, so a miss must not dead-end the add nor claim the
//     account doesn't exist. Only a lookup that confirms non-existence shows
//     the definitive "no such user" copy.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"
import { UsernameTypeahead, type RecipientValue } from "./UsernameTypeahead"
import { lookupUser } from "@/lib/frontier/members"

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

// AQU-781: the settled-miss path resolves the exact username via the unscoped
// lookup. Provide a jwt so the hook fires and mock the lookup per-test.
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt" }, loading: false }),
}))
vi.mock("@/lib/frontier/members", () => ({
  lookupUser: vi.fn(async () => null),
}))

// Default: unknown usernames don't resolve. Individual tests override.
beforeEach(() => {
  vi.mocked(lookupUser).mockReset()
  vi.mocked(lookupUser).mockResolvedValue(null)
})

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

  it("AQU-781: multi-select — an out-of-scope exact match is offered as a real add, not a false 'no such user'", async () => {
    // Scoped search misses "zed", but the unscoped lookup resolves them.
    vi.mocked(lookupUser).mockResolvedValue({ id: 77, username: "zed" })
    const onToggleResult = vi.fn()
    render(<Harness multiSelect scopedSearch onToggleResult={onToggleResult} />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: "zed" } })

    // Must not assert non-existence for a user who exists out of scope.
    expect(await screen.findByText(/is an aquilla user/i)).toBeInTheDocument()
    expect(screen.queryByText(/no aquilla user named/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /add zed/i }))
    expect(onToggleResult).toHaveBeenCalledWith({ id: 77, username: "zed" })
  })

  it("AQU-781: single-pick — an out-of-scope exact match can be picked (verifies the recipient)", async () => {
    vi.mocked(lookupUser).mockResolvedValue({ id: 88, username: "zed" })
    render(<Harness multiSelect={false} scopedSearch />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: "zed" } })

    fireEvent.click(await screen.findByRole("button", { name: /add zed/i }))
    // Picking sets value.resolved, which surfaces the "verified" badge.
    expect(await screen.findByText(/verified/i)).toBeInTheDocument()
  })

  it("AQU-781: shows the definitive not-found only after the unscoped lookup confirms the miss", async () => {
    // lookupUser default → null (truly no such account).
    render(<Harness multiSelect={false} scopedSearch />)
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: "zed" } })

    expect(await screen.findByText(/no aquilla user named "zed"/i)).toBeInTheDocument()
    expect(vi.mocked(lookupUser)).toHaveBeenCalledWith("jwt", "zed")
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
