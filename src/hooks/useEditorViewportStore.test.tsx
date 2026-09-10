// AQU-1016: `visibleCellIds`/`trackedCellRef` used to be ProjectWorkspace
// `useState` — every virtualized scroll step re-rendered the ~11.5k-line
// workspace shell, whether or not anything on screen cared about the new
// value. This store decouples writers (EditorTable's per-scroll-step
// reporting) from readers: a reader passing `active: false` (the shell,
// most of the time — no agent workbench open, translate-as-read off, no
// parallel-bibles panel shown) must never re-render on a scroll update,
// while a reader passing `active: true` (the real consumer) must.
import { useEffect } from "react"
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

// These components exist to COUNT how often they re-render. A component may
// not mutate props or module state during render (`react-hooks/immutability`),
// so each bumps its counter from a dependency-less effect — i.e. once per
// COMMIT. That is the measure this ticket cares about anyway: when a store
// snapshot is `Object.is`-equal, React bails out before rendering at all, so
// a flat commit count is exactly the "no extra work for this subscriber"
// claim. A re-render that reached the DOM always commits.
const renderCounts = { shell: 0, visibleIds: 0, trackedRef: 0 }

function resetRenderCounts(): void {
  renderCounts.shell = 0
  renderCounts.visibleIds = 0
  renderCounts.trackedRef = 0
}

function Shell() {
  useEffect(() => { renderCounts.shell++ })
  // Mirrors ProjectWorkspace: the shell has no live consumer for the
  // viewport signals in the common case, so it subscribes inactive.
  useVisibleCellIds(false)
  useTrackedCellRef(false)
  return <div data-testid="shell">shell</div>
}

function VisibleIdsConsumer() {
  useEffect(() => { renderCounts.visibleIds++ })
  const ids = useVisibleCellIds(true)
  return <div data-testid="consumer">{ids.join(",")}</div>
}

function TrackedRefConsumer() {
  useEffect(() => { renderCounts.trackedRef++ })
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
    resetRenderCounts()
    // Reach into the same store the hooks use by subscribing via a consumer.
    render(<VisibleIdsConsumer />)
    const before = renderCounts.visibleIds
    act(() => {
      setVisibleCellIds([])
      // same content as initial empty snapshot — no notification expected
    })
    expect(renderCounts.visibleIds).toBe(before)
    act(() => {
      setVisibleCellIds(["x"])
    })
    expect(renderCounts.visibleIds).toBe(before + 1)
    act(() => {
      setVisibleCellIds(["x"]) // identical content, new array identity
    })
    expect(renderCounts.visibleIds).toBe(before + 1)
    resetEditorViewportStores()
  })

  it("does not re-render an inactive shell on scroll-driven visible-id updates, but does re-render the active consumer", () => {
    resetEditorViewportStores()
    resetRenderCounts()
    render(
      <>
        <Shell />
        <VisibleIdsConsumer />
      </>,
    )
    const shellBefore = renderCounts.shell
    const consumerBefore = renderCounts.visibleIds

    act(() => {
      setVisibleCellIds(["cell-1", "cell-2"])
    })

    expect(renderCounts.shell).toBe(shellBefore) // shell: zero extra renders
    expect(renderCounts.visibleIds).toBe(consumerBefore + 1) // consumer: re-rendered
    expect(screen.getByTestId("consumer").textContent).toBe("cell-1,cell-2")

    act(() => {
      setVisibleCellIds(["cell-3"])
    })
    expect(renderCounts.shell).toBe(shellBefore)
    expect(renderCounts.visibleIds).toBe(consumerBefore + 2)

    resetEditorViewportStores()
  })

  it("does not re-render an inactive shell on tracked-ref updates, but does re-render the active consumer", () => {
    resetEditorViewportStores()
    resetRenderCounts()
    render(
      <>
        <Shell />
        <TrackedRefConsumer />
      </>,
    )
    const shellBefore = renderCounts.shell
    const consumerBefore = renderCounts.trackedRef

    act(() => {
      setTrackedCellRef("GEN 1:1")
    })

    expect(renderCounts.shell).toBe(shellBefore)
    expect(renderCounts.trackedRef).toBe(consumerBefore + 1)
    expect(screen.getByTestId("tracked").textContent).toBe("GEN 1:1")

    resetEditorViewportStores()
  })
})
