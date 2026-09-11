import { act, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CellPresenceBadges, PEER_TYPING_LINGER_MS } from "./CellPresenceBadges"
import type { CellPresencePeer } from "@/lib/sync/presence-store"

function peer(over: Partial<CellPresencePeer> = {}): CellPresencePeer {
  return {
    peerId: "alice",
    username: "alice",
    color: "#3b82f6",
    cellId: "cell-1",
    isEditing: false,
    lastSeenAt: 1,
    ...over,
  }
}

describe("CellPresenceBadges", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders nothing when no peer is on the row", () => {
    const { container } = render(<CellPresenceBadges peers={[]} />)
    expect(container.querySelector("[data-cell-presence]")).toBeNull()
  })

  it("shows a viewing peer without any lock or selection", () => {
    // The whole point: a colleague is visible the moment they land on a row,
    // not only once they hold the lease and have published a caret.
    const { container } = render(<CellPresenceBadges peers={[peer()]} />)
    const badge = container.querySelector("[data-cell-presence]")
    expect(badge?.getAttribute("data-cell-presence-state")).toBe("viewing")
    expect(badge?.textContent).toContain("alice")
    expect(badge?.textContent).toContain("viewing")
  })

  it("distinguishes the lease holder and counts extra peers", () => {
    const { container } = render(
      <CellPresenceBadges
        peers={[peer({ isEditing: true }), peer({ peerId: "bob", username: "bob" })]}
      />,
    )
    const badge = container.querySelector("[data-cell-presence]")
    expect(badge?.getAttribute("data-cell-presence-state")).toBe("editing")
    expect(badge?.textContent).toContain("+1")
    expect(container.querySelectorAll("[data-cell-presence] [title]")).toHaveLength(2)
  })

  it("flips to typing while the live draft changes and back after the linger window", () => {
    vi.useFakeTimers()
    let clock = 10_000
    const now = () => clock
    const sel = (draftText: string) => ({ side: "target" as const, anchor: 0, head: 0, draftText })
    const { container, rerender } = render(
      <CellPresenceBadges peers={[peer({ isEditing: true, selection: sel("He") })]} now={now} />,
    )
    const state = () => container.querySelector("[data-cell-presence]")?.getAttribute("data-cell-presence-state")
    // A first sighting of a draft is not typing — only a CHANGE is.
    expect(state()).toBe("editing")

    clock += 100
    rerender(<CellPresenceBadges peers={[peer({ isEditing: true, selection: sel("Hello") })]} now={now} />)
    expect(state()).toBe("typing")

    clock += PEER_TYPING_LINGER_MS + 10
    act(() => {
      vi.advanceTimersByTime(PEER_TYPING_LINGER_MS + 10)
    })
    expect(state()).toBe("editing")
  })
})
