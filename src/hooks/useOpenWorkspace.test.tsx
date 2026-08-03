import { act, fireEvent, render, screen } from "@testing-library/react"
import { Suspense, lazy } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { useOpenWorkspace } from "@/hooks/useOpenWorkspace"

// A lazy destination whose module resolution the test controls, standing in
// for the real lazy workspace chunk fetch (the async window AQU-737 covers).
function deferredLazy() {
  let resolveModule!: () => void
  const Component = lazy(
    () =>
      new Promise<{ default: () => React.JSX.Element }>((resolve) => {
        resolveModule = () =>
          resolve({ default: () => <div>Workspace ready</div> })
      }),
  )
  return { Component, resolveModule: () => resolveModule() }
}

function SourcePage({ onOther }: { onOther: () => void }) {
  const { open, isPending, overlay } = useOpenWorkspace()
  return (
    <div>
      {overlay}
      <button
        type="button"
        onClick={() => open("/project/p1/editor")}
        disabled={isPending}
      >
        Open project
      </button>
      <button type="button" onClick={onOther}>
        Other action
      </button>
    </div>
  )
}

function renderJourney(onOther: () => void = () => {}) {
  const { Component: Workspace, resolveModule } = deferredLazy()
  render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/projects/p1" element={<SourcePage onOther={onOther} />} />
          <Route path="/project/p1/editor" element={<Workspace />} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  )
  return { resolveModule }
}

describe("useOpenWorkspace overlay (AQU-737)", () => {
  // WHY: spinning + disabling the clicked control is not enough — every OTHER
  // control on the surface stays live during the lazy-chunk window unless the
  // whole display area is covered. The overlay must be driven by the real
  // transition (up while suspended, gone the moment the destination commits),
  // never a timer.
  it("covers the display area while the destination chunk is in flight, then clears on commit", async () => {
    const { resolveModule } = renderJourney()

    // Idle: no overlay, nothing blocked.
    expect(screen.queryByTestId("workspace-opening-overlay")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Open project" }))

    // The transition is suspended on the unresolved chunk: the blocking
    // overlay is up and the clicked control is disabled.
    const overlay = await screen.findByTestId("workspace-opening-overlay")
    expect(overlay).toHaveAttribute("aria-busy", "true")
    expect(overlay).toHaveAttribute("aria-label", "Opening project")
    expect(screen.getByRole("button", { name: "Open project" })).toBeDisabled()

    // Chunk lands → destination commits → overlay is gone (no lingering block).
    await act(async () => resolveModule())
    expect(await screen.findByText("Workspace ready")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-opening-overlay")).toBeNull()
  })

  it("other controls remain wired but sit beneath the viewport-blocking layer", async () => {
    const onOther = vi.fn()
    renderJourney(onOther)

    fireEvent.click(screen.getByRole("button", { name: "Open project" }))
    const overlay = await screen.findByTestId("workspace-opening-overlay")

    // happy-dom has no hit-testing, so assert the mechanism instead: the layer
    // is fixed + full-viewport and does NOT opt out of pointer events, so in a
    // real browser it intercepts clicks aimed at anything beneath it.
    expect(overlay).toHaveClass("fixed", "inset-0")
    expect(overlay.className).not.toContain("pointer-events-none")
    expect(overlay.parentElement).toBe(document.body)
  })
})
