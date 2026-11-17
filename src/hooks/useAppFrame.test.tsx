import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { Suspense, lazy, type ReactNode } from "react"
import { useAppFrame, useHoldAppFrame } from "./useAppFrame"

const frameState = () => document.documentElement.dataset.appFrame
const isFramed = () => frameState() != null
const settle = () => act(async () => { await Promise.resolve() })

function Frame({ children }: { children?: ReactNode }) {
  useAppFrame()
  return <>{children}</>
}
function Fallback() {
  useHoldAppFrame()
  return null
}
function Page() {
  return null
}

describe("useAppFrame", () => {
  afterEach(async () => {
    cleanup()
    await settle()
  })

  it("is on while a frame is mounted, from the first paint", async () => {
    const { unmount } = render(<Frame />)
    expect(isFramed()).toBe(true)
    unmount()
    await settle()
    expect(isFramed()).toBe(false)
  })

  it("never drops between one route's frame and the next", async () => {
    const seen: boolean[] = []
    const observer = new MutationObserver(() => seen.push(isFramed()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-app-frame"] })
    const { rerender } = render(<Frame key="a" />)
    rerender(<Frame key="b" />)
    await settle()
    observer.disconnect()
    expect(isFramed()).toBe(true)
    expect(seen).not.toContain(false)
  })

  it("stays up through a lazy route's loading fallback, then goes for a page outside it", async () => {
    const { rerender } = render(<Frame />)
    rerender(<Fallback />)
    await settle()
    expect(isFramed()).toBe(true)
    // Held, not "true": no AppShell header is on screen, so the drag strip
    // (hidden only under "true") stays the window's drag handle.
    expect(frameState()).toBe("held")
    rerender(<Page />)
    await settle()
    expect(isFramed()).toBe(false)
  })

  it("a fallback alone never raises the frame", async () => {
    render(<Fallback />)
    await settle()
    expect(isFramed()).toBe(false)
  })

  it("holds across a real Suspense hand-over", async () => {
    let resolve: (m: { default: () => ReactNode }) => void = () => {}
    const chunk = new Promise<{ default: () => ReactNode }>((r) => { resolve = r })
    const Lazy = lazy(() => chunk)
    const { rerender } = render(<Suspense fallback={<Fallback />}><Frame /></Suspense>)
    rerender(<Suspense fallback={<Fallback />}><Lazy /></Suspense>)
    await settle()
    expect(frameState()).toBe("held")
    await act(async () => { resolve({ default: () => <Frame /> }); await chunk })
    // React throttles the reveal; once the new AppShell commits it is "true".
    await waitFor(() => expect(frameState()).toBe("true"))
  })
})
