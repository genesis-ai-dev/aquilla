import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SlotTooltipScope, TimelineSlotButton } from "./TimelineSlotButton"

function Lane({ count, hotIndex = -1 }: { count: number; hotIndex?: number }) {
  return (
    <TooltipProvider delay={0}>
      <SlotTooltipScope>
        {Array.from({ length: count }, (_, i) => (
          <TimelineSlotButton key={i} testId={`slot-${i}`} label={`Record line ${i}`} hot={i === hotIndex}>
            <span />
          </TimelineSlotButton>
        ))}
      </SlotTooltipScope>
    </TooltipProvider>
  )
}

type Fiber = { child: Fiber | null; sibling: Fiber | null; return: Fiber | null }

/** Every React fiber in the tree that holds `node`. */
function fibersAround(node: Element): number {
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"))
  if (!key) throw new Error("no React fiber on the node")
  let top = (node as unknown as Record<string, Fiber>)[key]
  while (top.return) top = top.return
  let count = 0
  const walk = (f: Fiber | null) => {
    for (; f; f = f.sibling) {
      count++
      walk(f.child)
    }
  }
  walk(top)
  return count
}

function hover(el: Element) {
  fireEvent.pointerEnter(el, { pointerType: "mouse" })
  fireEvent.mouseEnter(el)
}

describe("TimelineSlotButton", () => {
  // AQU-2655: a lane draws one of these per empty stretch and per unrecorded
  // line — 208 on a two-file project — and a whole tooltip tree under each
  // was most of the voice studio's renders on open. The lane's buttons share
  // one tooltip root, so a button costs a couple of fibers, not a tree.
  it("adds a couple of fibers per button, not a tooltip tree", () => {
    const one = render(<Lane count={1} />)
    const base = fibersAround(screen.getByTestId("slot-0"))
    one.unmount()
    render(<Lane count={21} />)
    const perButton = (fibersAround(screen.getByTestId("slot-0")) - base) / 20
    expect(perButton).toBeLessThanOrEqual(4)
  })

  it("still names each button in its own tooltip, and the name is the button's", async () => {
    render(<Lane count={3} hotIndex={1} />)
    const second = screen.getByRole("button", { name: "Record line 1" })
    hover(second)
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Record line 1"))

    fireEvent.mouseLeave(second)
    const third = screen.getByRole("button", { name: "Record line 2" })
    hover(third)
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Record line 2"))
  })

  // AppTooltip's rule: opening a tooltip never remounts its trigger.
  it("keeps the same button element when its tooltip opens", async () => {
    render(<Lane count={2} hotIndex={0} />)
    const before = screen.getByTestId("slot-0")
    hover(before)
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy())
    expect(screen.getByTestId("slot-0")).toBe(before)
  })
})
