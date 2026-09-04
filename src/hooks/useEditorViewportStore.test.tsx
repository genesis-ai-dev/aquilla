// AQU-1016: `visibleCellIds`/`trackedCellRef` used to be ProjectWorkspace
// `useState` — every virtualized scroll step re-rendered the ~11.5k-line
// workspace shell, whether or not anything on screen cared about the new
// value. This store decouples writers (EditorTable's per-scroll-step
// reporting) from readers: a reader passing `active: false` (the shell,
// most of the time — no agent workbench open, translate-as-read off, no
// parallel-bibles panel shown) must never re-render on a scroll update,
// while a reader passing `active: true` (the real consumer) must.
import { describe, expect, it } from "vitest"
import { act, render, screen } from "@testing-library/react"
import {
  getTrackedCellRef,
  getVisibleCellIds,
  resetEditorViewportStores,
  setTrackedCellRef,
  setVisibleCellIds,
  useTrackedCellRef,
  useVisibleCellIds,
} from "./useEditorViewportStore"

function Shell({ renders }: { renders: { count: number } }) {
  renders.count++
  // Mirrors ProjectWorkspace: the shell has no live consumer for the
  // viewport signals in the common case, so it subscribes inactive.
  useVisibleCellIds(false)
  useTrackedCellRef(false)
  return <div data-testid="shell">shell</div>
}

function VisibleIdsConsumer({ renders }: { renders: { count: number } }) {
  renders.count++
  const ids = useVisibleCellIds(true)
  return <div data-testid="consumer">{ids.join(",")}</div>
}

function TrackedRefConsumer({ renders }: { renders: { count: number } }) {
  renders.count++
  const ref = useTrackedCellRef(true)
  return <div data-testid="tracked">{ref ?? "none"}</div>
}

describe("useEditorViewportStore", () => {
  it("non-reactive get/set round-trips without requiring a subscriber", () => {
    resetEditorViewportStores()
    setVisibleCellIds(["a", "b"])
    expect(getVisibleCellIds()).toEqual(["a", "b"])
    setTrackedCellRef("GEN 1:1")
    expect(getTrackedCellRef()).toBe("GEN 1:1")
    resetEditorViewportStores()
  })

  it("skips renotifying content-identical array updates (no-op skip)", () => {
    resetEditorViewportStores()
    let notifications = 0
    // Reach into the same store the hooks use by subscribing via a consumer.
    const renders = { count: 0 }
    render(<VisibleIdsConsumer renders={renders} />)
    const before = renders.count
    act(() => {
      setVisibleCellIds([])
      // same content as initial empty snapshot — no notification expected
    })
    expect(renders.count).toBe(before)
    act(() => {
      setVisibleCellIds(["x"])
    })
    expect(renders.count).toBe(before + 1)
    act(() => {
      setVisibleCellIds(["x"]) // identical content, new array identity
    })
    expect(renders.count).toBe(before + 1)
    void notifications
    resetEditorViewportStores()
  })

  it("does not re-render an inactive shell on scroll-driven visible-id updates, but does re-render the active consumer", () => {
    resetEditorViewportStores()
    const shellRenders = { count: 0 }
    const consumerRenders = { count: 0 }
    render(
      <>
        <Shell renders={shellRenders} />
        <VisibleIdsConsumer renders={consumerRenders} />
      </>,
    )
    const shellBefore = shellRenders.count
    const consumerBefore = consumerRenders.count

    act(() => {
      setVisibleCellIds(["cell-1", "cell-2"])
    })

    expect(shellRenders.count).toBe(shellBefore) // shell: zero extra renders
    expect(consumerRenders.count).toBe(consumerBefore + 1) // consumer: re-rendered
    expect(screen.getByTestId("consumer").textContent).toBe("cell-1,cell-2")

    act(() => {
      setVisibleCellIds(["cell-3"])
    })
    expect(shellRenders.count).toBe(shellBefore)
    expect(consumerRenders.count).toBe(consumerBefore + 2)

    resetEditorViewportStores()
  })

  it("does not re-render an inactive shell on tracked-ref updates, but does re-render the active consumer", () => {
    resetEditorViewportStores()
    const shellRenders = { count: 0 }
    const consumerRenders = { count: 0 }
    render(
      <>
        <Shell renders={shellRenders} />
        <TrackedRefConsumer renders={consumerRenders} />
      </>,
    )
    const shellBefore = shellRenders.count
    const consumerBefore = consumerRenders.count

    act(() => {
      setTrackedCellRef("GEN 1:1")
    })

    expect(shellRenders.count).toBe(shellBefore)
    expect(consumerRenders.count).toBe(consumerBefore + 1)
    expect(screen.getByTestId("tracked").textContent).toBe("GEN 1:1")

    resetEditorViewportStores()
  })
})
