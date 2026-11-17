// Multi-select typeahead extensions for the member-add surfaces:
//   - `suggestions` (eligible org colleagues) render as checkbox rows on
//     focus, before any search, and merge dedup'd with search results.
//   - A settled search miss resolves the exact typed username against the
//     unscoped lookup (AQU-781): the scoped search (AQU-321) can't see
//     out-of-scope users, so a miss must not dead-end the add nor claim the
//     account doesn't exist. Only a lookup that confirms non-existence shows
//     the definitive "no such user" copy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
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
  lookupProjectId,
  showModeToggle = false,
  onStageTyped = () => {},
  onToggleResult = () => {},
}: {
  multiSelect: boolean
  suggestions?: Array<{ id: number; username: string; secondary?: string | null }>
  emptySuggestionsHint?: string
  scopedSearch?: boolean
  lookupProjectId?: string | null
  showModeToggle?: boolean
  onStageTyped?: () => void
  onToggleResult?: (u: { id: number; username: string }) => void
}) {
  const [value, setValue] = useState<RecipientValue>({ mode: "username", raw: "" })
  return (
    <UsernameTypeahead
      value={value}
      onChange={setValue}
      showModeToggle={showModeToggle}
      suggestions={suggestions}
      emptySuggestionsHint={emptySuggestionsHint}
      scopedSearch={scopedSearch}
      lookupProjectId={lookupProjectId}
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
    // AQU-2576 added a third argument: the project scoping an email lookup.
    // Unscoped surfaces pass null, which keeps the route username-only.
    expect(vi.mocked(lookupUser)).toHaveBeenCalledWith("jwt", "zed", null)
  })

  // AQU-2576: a project owner is given a reviewer's EMAIL, not their handle.
  // Where a project scopes the lookup, the address resolves to the account and
  // a miss says so in the address's own terms — "no account has verified this
  // email" (AQU-2638), not "no user named n@example.com".
  describe("AQU-2576: resolving an add-member target by email", () => {
    const EMAIL = "naladda@proton.me"

    it("scopes the lookup to the project when one is given", async () => {
      vi.mocked(lookupUser).mockResolvedValue({ id: 1220, username: "Naladda" })
      render(<Harness multiSelect scopedSearch lookupProjectId="proj-1" />)
      fireEvent.focus(input())
      fireEvent.change(input(), { target: { value: EMAIL } })

      expect(await screen.findByText(/is an aquilla user/i)).toBeInTheDocument()
      expect(vi.mocked(lookupUser)).toHaveBeenCalledWith("jwt", EMAIL, "proj-1")
    })

    it("offers the resolved account by username — the string the owner needs", async () => {
      vi.mocked(lookupUser).mockResolvedValue({ id: 1220, username: "Naladda" })
      const onToggleResult = vi.fn()
      render(
        <Harness multiSelect scopedSearch lookupProjectId="proj-1" onToggleResult={onToggleResult} />,
      )
      fireEvent.focus(input())
      fireEvent.change(input(), { target: { value: EMAIL } })

      fireEvent.click(await screen.findByRole("button", { name: /add naladda/i }))
      expect(onToggleResult).toHaveBeenCalledWith({ id: 1220, username: "Naladda" })
    })

    // AQU-2638: the lookup matches VERIFIED addresses only, and answers the
    // same for "an account uses this address but never verified it" as for "no
    // account uses it" — so the one sentence shown has to be true in both
    // cases. Claiming no account USES the address told an owner who typed
    // their own signed-in email that they had no account.
    it("says no account has VERIFIED the address — never that none uses it", async () => {
      render(<Harness multiSelect scopedSearch lookupProjectId="proj-1" />)
      fireEvent.focus(input())
      fireEvent.change(input(), { target: { value: EMAIL } })

      const miss = await screen.findByText(
        /no aquilla account has verified the email naladda@proton\.me/i,
      )
      expect(miss).toBeInTheDocument()
      expect(screen.queryByText(/uses the email/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/no aquilla user named/i)).not.toBeInTheDocument()
    })

    it("names all three ways forward, so the dead end has an exit", async () => {
      render(<Harness multiSelect scopedSearch lookupProjectId="proj-1" showModeToggle />)
      fireEvent.focus(input())
      fireEvent.change(input(), { target: { value: EMAIL } })

      const miss = await screen.findByText(/no aquilla account has verified the email/i)
      // add by username · send an invite link · verify in account settings
      expect(miss).toHaveTextContent(/aquilla username/i)
      expect(miss).toHaveTextContent(/invite link/i)
      expect(miss).toHaveTextContent(/account settings/i)
      // The existing route to the Invite link tab survives the rewording.
      expect(
        screen.getByRole("button", { name: /invite by email instead/i }),
      ).toBeInTheDocument()
    })

    it("keeps the username wording for a typed username, scoped or not", async () => {
      render(<Harness multiSelect scopedSearch lookupProjectId="proj-1" />)
      fireEvent.focus(input())
      fireEvent.change(input(), { target: { value: "zed" } })

      expect(await screen.findByText(/no aquilla user named "zed"/i)).toBeInTheDocument()
    })

    it("tells the person an email works here, only where one actually would", () => {
      const hint = /enter their email address instead/i
      const { unmount } = render(<Harness multiSelect scopedSearch lookupProjectId="proj-1" />)
      expect(screen.getByText(hint)).toBeInTheDocument()
      unmount()

      render(<Harness multiSelect scopedSearch />)
      expect(screen.queryByText(hint)).not.toBeInTheDocument()
    })
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

// AQU-2609: the suggestion list grants project access. A row the operator
// cannot read in full — "Math…" next to "matth…" — is a mis-grant waiting to
// happen, so the list is no longer pinned to the narrow field's width and each
// row can carry a secondary identifier.
describe("UsernameTypeahead — identifying people in the dropdown (AQU-2609)", () => {
  function mockInputRect(rect: { left: number; width: number }) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: rect.left,
      y: 100,
      left: rect.left,
      right: rect.left + rect.width,
      width: rect.width,
      height: 32,
      top: 100,
      bottom: 132,
      toJSON: () => ({}),
    } as DOMRect)
  }

  function dropdownFor(name: string): HTMLElement {
    const el = screen.getByRole("checkbox", { name }).closest(".fixed")
    expect(el).not.toBeNull()
    return el as HTMLElement
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("is anchored to the field but free to grow past its width", () => {
    mockInputRect({ left: 40, width: 220 })
    render(<Harness multiSelect suggestions={[{ id: 5, username: "dana" }]} />)
    fireEvent.focus(input())

    const el = dropdownFor("dana")
    // The field is the floor, not the ceiling: no fixed width pins the list
    // (the regression — `width: 220px` — cut usernames to a few characters).
    expect(el.style.minWidth).toBe("220px")
    expect(el.style.width).toBe("")
    expect(el.className).toContain("w-max")
    expect(parseFloat(el.style.maxWidth)).toBeGreaterThan(220)
  })

  it("never grows past the viewport's right edge", () => {
    // Field pushed right: only (innerWidth - left - 8px gutter) is available,
    // which is less than the field itself — so the list matches the field.
    mockInputRect({ left: window.innerWidth - 100, width: 220 })
    render(<Harness multiSelect suggestions={[{ id: 5, username: "dana" }]} />)
    fireEvent.focus(input())

    const el = dropdownFor("dana")
    expect(el.style.minWidth).toBe("220px")
    expect(el.style.maxWidth).toBe("220px")
  })

  it("keeps two usernames that share a prefix fully distinguishable", () => {
    mockInputRect({ left: 40, width: 220 })
    render(
      <Harness
        multiSelect
        suggestions={[
          { id: 7, username: "Mathew-Ebenezer-Translator" },
          { id: 8, username: "matthew-ebenezer-reviewer" },
        ]}
      />,
    )
    fireEvent.focus(input())

    // Each row names its person in full — as visible text and, for the case
    // where the cap still clips, in the row's hover title.
    for (const username of [
      "Mathew-Ebenezer-Translator",
      "matthew-ebenezer-reviewer",
    ]) {
      const row = screen.getByRole("checkbox", { name: username })
      expect(row).toHaveAttribute("title", username)
      expect(row.textContent).toContain(username)
    }
  })

  it("shows the secondary identifier a caller supplies, in the row and its title", () => {
    mockInputRect({ left: 40, width: 220 })
    render(
      <Harness
        multiSelect
        suggestions={[
          { id: 7, username: "Mathew", secondary: "mathew.k@biblica.com" },
          { id: 8, username: "matthew", secondary: "m.taylor@biblica.com" },
        ]}
      />,
    )
    fireEvent.focus(input())

    expect(screen.getByText("mathew.k@biblica.com")).toBeInTheDocument()
    expect(screen.getByText("m.taylor@biblica.com")).toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", { name: /^Mathew mathew\.k@biblica\.com$/ }),
    ).toHaveAttribute("title", "Mathew — mathew.k@biblica.com")
  })

  it("leaves the row's accessible name and click-to-toggle untouched", () => {
    mockInputRect({ left: 40, width: 220 })
    const onToggleResult = vi.fn()
    render(
      <Harness
        multiSelect
        suggestions={[{ id: 5, username: "dana", secondary: "dana@example.com" }]}
        onToggleResult={onToggleResult}
      />,
    )
    fireEvent.focus(input())
    fireEvent.click(screen.getByRole("checkbox", { name: /dana/ }))
    expect(onToggleResult).toHaveBeenCalledWith({
      id: 5,
      username: "dana",
      secondary: "dana@example.com",
    })
  })
})
