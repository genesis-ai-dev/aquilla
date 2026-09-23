// AQU-1278: the row is memoized, and memoization is a CONTRACT, not a wrapper
// — one per-row arrow in the board and every row re-renders on every board
// state change again, with the memo comparing props for nothing. The wrapper
// is asserted once; the rest of the file pins the contract by mocking the row
// and checking that what the board hands it is identity-stable while the
// board's own state churns.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { ComponentProps } from "react"
import { PlanBoard } from "./PlanBoard"
import { planUnitId, type PlanUnit } from "@/lib/plan/plan-status"

type RowProps = ComponentProps<typeof import("./PlanRow").PlanRow>
const rowRenders: RowProps[] = []
vi.mock("./PlanRow", () => ({
  PlanRow: (props: RowProps) => {
    rowRenders.push(props)
    return null
  },
}))

const NOW = Date.parse("2026-09-02T09:00:00Z")

function unit(fileId: string, over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    fileId, fileName: fileId, sectionKey: "",
    totalCount: 100, filledCount: 50, validatedCount: 20,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null,
    ...over,
  } as PlanUnit
}

const UNITS = [unit("a"), unit("b"), unit("c")]

/** The rows of the LAST render pass, keyed by unit id. */
function lastPass(): Map<string, RowProps> {
  const map = new Map<string, RowProps>()
  // Later entries overwrite earlier ones, so the map holds the final pass.
  for (const props of rowRenders) map.set(planUnitId(props.unit), props)
  return map
}

describe("the row's memo contract", () => {
  it("the real export is actually wrapped in memo", async () => {
    const real = await vi.importActual<typeof import("./PlanRow")>("./PlanRow")
    expect((real.PlanRow as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"))
  })

  it("hands every row identity-stable props while the selection moves", () => {
    rowRenders.length = 0
    const onSelect = vi.fn()
    const { rerender } = render(
      <PlanBoard units={UNITS} now={NOW} projectId="p1" selectedId={null} onSelect={onSelect}
        onOpenShortfall={vi.fn()} />,
    )
    const before = lastPass()
    rowRenders.length = 0
    rerender(
      <PlanBoard units={UNITS} now={NOW} projectId="p1" selectedId="b:" onSelect={onSelect}
        onOpenShortfall={vi.fn()} />,
    )
    const after = lastPass()

    for (const id of ["a:", "c:"]) {
      const b = before.get(id)!
      const a = after.get(id)!
      // Every prop the memo will shallow-compare, identical by identity — so
      // the real (memoized) row would not have re-rendered at all.
      for (const key of Object.keys(a) as Array<keyof RowProps>) {
        if (key === "onOpenShortfall") continue // fresh vi.fn passed on purpose above
        expect(Object.is(a[key], b[key]), `${id} ${String(key)}`).toBe(true)
      }
    }
    expect(before.get("b:")!.selected).toBe(false)
    expect(after.get("b:")!.selected).toBe(true)
  })

  it("keeps them stable while the board's own state churns too", () => {
    rowRenders.length = 0
    render(
      <PlanBoard units={UNITS} now={NOW} projectId="p1" selectedId={null} onSelect={vi.fn()} />,
    )
    const before = lastPass()
    rowRenders.length = 0
    // Typing in the filter re-renders the board on internal state. "a" keeps
    // all three rows visible (every name contains it? no — names are a, b, c;
    // use empty-then-same text instead: focus + a no-op change event).
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "" } })
    fireEvent.click(screen.getByTestId("plan-view-order"))
    fireEvent.click(screen.getByTestId("plan-view-status"))
    const after = lastPass()
    for (const id of ["a:", "b:", "c:"]) {
      const b = before.get(id)!
      const a = after.get(id)!
      for (const key of Object.keys(a) as Array<keyof RowProps>) {
        if (key === "showStatus") continue // genuinely differs between arrangements
        expect(Object.is(a[key], b[key]), `${id} ${String(key)}`).toBe(true)
      }
    }
  })
})
