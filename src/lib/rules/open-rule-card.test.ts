/**
 * AQU-1634 — one violation rule card at a time.
 *
 * The card is a single bottom-right toast, but its open state used to live in
 * each EditorRow's own `useState`, so clicking a second row's underline stacked
 * a second card. These cover the store that now owns it.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import {
  closeRuleCard,
  openRuleCard,
  resetRuleCardForTests,
  useOpenRuleCard,
} from "./open-rule-card"

beforeEach(() => resetRuleCardForTests())

/** The store now hands back the whole card (AQU-1740 added the clicked
 *  finding's hash); these cases only care which rule is open. */
const useOpenRuleId = (cellId: string): string | null =>
  useOpenRuleCard(cellId)?.ruleId ?? null

describe("open-rule-card", () => {
  it("reports the open rule only to the cell that owns the card", () => {
    const owner = renderHook(() => useOpenRuleId("cell-1"))
    const other = renderHook(() => useOpenRuleId("cell-2"))

    openRuleCard("cell-1", "r1")
    owner.rerender()
    other.rerender()

    expect(owner.result.current).toBe("r1")
    expect(other.result.current).toBeNull()
  })

  it("replaces the open card when another cell's underline opens one", () => {
    const first = renderHook(() => useOpenRuleId("cell-1"))
    const second = renderHook(() => useOpenRuleId("cell-2"))

    openRuleCard("cell-1", "r1")
    openRuleCard("cell-2", "r2")
    first.rerender()
    second.rerender()

    // The first cell no longer renders a card — so nothing stacks.
    expect(first.result.current).toBeNull()
    expect(second.result.current).toBe("r2")
  })

  it("replaces the open card when a second rule on the SAME cell opens one", () => {
    const hook = renderHook(() => useOpenRuleId("cell-1"))

    openRuleCard("cell-1", "r1")
    openRuleCard("cell-1", "r2")
    hook.rerender()

    expect(hook.result.current).toBe("r2")
  })

  it("closes the card", () => {
    const hook = renderHook(() => useOpenRuleId("cell-1"))

    openRuleCard("cell-1", "r1")
    closeRuleCard()
    hook.rerender()

    expect(hook.result.current).toBeNull()
  })

  it("a row tearing down cannot close a card that has moved to another row", () => {
    const second = renderHook(() => useOpenRuleId("cell-2"))

    openRuleCard("cell-1", "r1")
    openRuleCard("cell-2", "r2")
    // cell-1's unmount cleanup fires after the card already moved.
    closeRuleCard("cell-1")
    second.rerender()

    expect(second.result.current).toBe("r2")
  })

  it("re-opening the identical card keeps the same snapshot identity", () => {
    const snapshots: (string | null)[] = []
    const hook = renderHook(() => {
      const value = useOpenRuleId("cell-1")
      snapshots.push(value)
      return value
    })

    openRuleCard("cell-1", "r1")
    hook.rerender()
    const rendersAfterOpen = snapshots.length

    // A no-op open must not notify, so React does not re-render from the store.
    openRuleCard("cell-1", "r1")
    expect(snapshots.length).toBe(rendersAfterOpen)
    expect(hook.result.current).toBe("r1")
  })

  it("closing when nothing is open is a no-op", () => {
    const hook = renderHook(() => useOpenRuleId("cell-1"))
    closeRuleCard()
    closeRuleCard("cell-1")
    hook.rerender()
    expect(hook.result.current).toBeNull()
  })

  // AQU-1740: the card carries WHICH finding of the rule was clicked, so its
  // waive accepts that match instead of the rule across the whole cell.
  it("carries the clicked finding's hash, and re-keys on a second finding of the same rule", () => {
    const hook = renderHook(() => useOpenRuleCard("cell-1"))

    openRuleCard("cell-1", "r1", "hash-a")
    hook.rerender()
    expect(hook.result.current).toEqual({ cellId: "cell-1", ruleId: "r1", matchHash: "hash-a" })

    openRuleCard("cell-1", "r1", "hash-b")
    hook.rerender()
    expect(hook.result.current?.matchHash).toBe("hash-b")
  })

  it("omits the hash for a card opened without one", () => {
    const hook = renderHook(() => useOpenRuleCard("cell-1"))
    openRuleCard("cell-1", "r1")
    hook.rerender()
    expect(hook.result.current).toEqual({ cellId: "cell-1", ruleId: "r1" })
  })

  // The no-op guard above compares the whole card, so the hash has to be part
  // of it: same rule, same cell, DIFFERENT match is a different card, and
  // treating it as a no-op would leave the first finding's waive gesture open.
  it("re-opening the same rule on a different finding is not a no-op", () => {
    const hook = renderHook(() => useOpenRuleCard("cell-1"))

    openRuleCard("cell-1", "r1", "hash-a")
    hook.rerender()
    expect(hook.result.current?.matchHash).toBe("hash-a")

    openRuleCard("cell-1", "r1", "hash-b")
    hook.rerender()
    expect(hook.result.current?.matchHash).toBe("hash-b")

    // ...and dropping back to the cell-wide card is a change too.
    openRuleCard("cell-1", "r1")
    hook.rerender()
    expect(hook.result.current?.matchHash).toBeUndefined()
  })
})
