import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { Suspense, use, type ReactNode } from "react"
import { useAppFrame, useHoldAppFrame } from "./useAppFrame"

const isFramed = () => document.documentElement.dataset.appFrame === "true"
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
    let resolve: () => void = () => {}
    const chunk = new Promise<void>((r) => { resolve = r })
    function Lazy() {
      use(chunk)
      return <Frame />
    }
    const { rerender } = render(<Suspense fallback={<Fallback />}><Frame /></Suspense>)
    rerender(<Suspense fallback={<Fallback />}><Lazy /></Suspense>)
    await settle()
    expect(isFramed()).toBe(true)
    await act(async () => { resolve(); await chunk })
    expect(isFramed()).toBe(true)
  })
})
