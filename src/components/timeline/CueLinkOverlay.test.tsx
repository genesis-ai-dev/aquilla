// Linking mode's click surface. (AQU-646 stage 4)
//
// The behaviour Sam asked for is precisely "when linking mode is off, clicking
// is just regular old clicking" — so the first and most important assertion
// here is a NEGATIVE one: with no overlay passed, a lane renders no link
// targets at all and nothing about a click can have changed.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

import { CueLinkOverlay } from "./CueLinkOverlay"
import { SourceRegionLane } from "./SourceRegionLane"
import { deriveSourceRegions } from "@/lib/timeline/source-regions"
import type { CellData } from "@/hooks/useCells"

const cell = (id: string, startTime: number, endTime: number, original = id): CellData =>
  ({ id, fileId: "f1", original, translated: "", medium: "text", startTime, endTime }) as unknown as CellData

const cues = [cell("cue-a", 10, 12, "I see him."), cell("cue-b", 20, 22, "Two.")]
const map = deriveSourceRegions(cues, 30)

function renderOverlay(over: Partial<React.ComponentProps<typeof CueLinkOverlay>> = {}) {
  const onPick = vi.fn()
  render(
    <CueLinkOverlay
      items={[
        { id: "cue-a", startSec: 10, endSec: 12 },
        { id: "cue-b", startSec: 20, endSec: 22 },
      ]}
      pxPerSec={10}
      pickedId={null}
      linkedIds={new Set()}
      unlinkedIds={new Set()}
      onPick={onPick}
      {...over}
    />,
  )
  return { onPick }
}

const stateOf = (id: string) =>
  screen.getAllByTestId("tl-link-target").find((el) => el.dataset.cellId === id)!.dataset.linkState

describe("linking mode is opt-in", () => {
  it("renders NO link targets when a lane gets no overlay", () => {
    // The normal state of the app. Nothing here is a "disabled" control — the
    // click surface does not exist, so seek/select/drag are untouched.
    render(
      <SourceRegionLane
        map={map}
        cells={cues}
        pxPerSec={10}
        viewStartSec={0}
        viewEndSec={30}
        selectedId={null}
        editable
        onSelect={vi.fn()}
        onSeek={vi.fn()}
        onSeekSec={vi.fn()}
      />,
    )
    expect(screen.queryAllByTestId("tl-link-target")).toHaveLength(0)
  })

  it("renders one target per visible chip once an overlay is given", () => {
    render(
      <SourceRegionLane
        map={map}
        cells={cues}
        pxPerSec={10}
        viewStartSec={0}
        viewEndSec={30}
        selectedId={null}
        editable
        onSelect={vi.fn()}
        onSeek={vi.fn()}
        onSeekSec={vi.fn()}
        linkOverlay={{
          pickedId: null,
          linkedIds: new Set(),
          unlinkedIds: new Set(["cue-b"]),
          onPick: vi.fn(),
        }}
      />,
    )
    expect(screen.getAllByTestId("tl-link-target")).toHaveLength(2)
    expect(stateOf("cue-b")).toBe("unlinked")
  })
})

describe("CueLinkOverlay", () => {
  it("reports the chip that was clicked", () => {
    const { onPick } = renderOverlay()
    fireEvent.click(screen.getAllByTestId("tl-link-target")[1])
    expect(onPick).toHaveBeenCalledWith("cue-b")
  })

  it("stops the click reaching the chip underneath", () => {
    // The chip still has its own seek handler; without this every pairing would
    // also move the transport.
    const onParentClick = vi.fn()
    const onPick = vi.fn()
    render(
      <div onClick={onParentClick}>
        <CueLinkOverlay
          items={[{ id: "cue-a", startSec: 10, endSec: 12 }]}
          pxPerSec={10}
          pickedId={null}
          linkedIds={new Set()}
          unlinkedIds={new Set()}
          onPick={onPick}
        />
      </div>,
    )
    fireEvent.click(screen.getByTestId("tl-link-target"))
    expect(onPick).toHaveBeenCalledOnce()
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it("marks picked, linked, unlinked and idle apart", () => {
    renderOverlay({ pickedId: "cue-a", linkedIds: new Set(["cue-b"]) })
    expect(stateOf("cue-a")).toBe("picked")
    expect(stateOf("cue-b")).toBe("linked")
  })

  it("lets the picked chip win over a linked mark", () => {
    // A chip can be both; "this is the one you are pairing FROM" is the more
    // useful thing to show.
    renderOverlay({ pickedId: "cue-a", linkedIds: new Set(["cue-a"]) })
    expect(stateOf("cue-a")).toBe("picked")
  })

  it("is reachable from the keyboard", () => {
    const { onPick } = renderOverlay()
    fireEvent.keyDown(screen.getAllByTestId("tl-link-target")[0], { key: "Enter" })
    expect(onPick).toHaveBeenCalledWith("cue-a")
  })

  it("places each target on its chip's own geometry", () => {
    renderOverlay()
    const [a] = screen.getAllByTestId("tl-link-target")
    expect(a.style.left).toBe("100px")
    expect(a.style.width).toBe("20px")
  })
})
