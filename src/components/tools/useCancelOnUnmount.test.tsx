import { StrictMode, useEffect } from "react"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useCancelOnUnmount } from "./useCancelOnUnmount"

const tick = () => new Promise((r) => setTimeout(r, 10))

function Run({ onCancel, mounted }: { onCancel: () => void; mounted: () => void }) {
  useEffect(() => mounted(), [mounted])
  useCancelOnUnmount(onCancel)
  return <p>run</p>
}

describe("useCancelOnUnmount (AQU-1937: headless runs under StrictMode)", () => {
  it("does not cancel on StrictMode's simulated unmount: the run stays alive", async () => {
    const onCancel = vi.fn()
    const mounted = vi.fn()
    render(<StrictMode><Run onCancel={onCancel} mounted={mounted} /></StrictMode>)
    await tick()
    // StrictMode really did mount → unmount → mount (dev)…
    expect(mounted).toHaveBeenCalledTimes(2)
    // …and the run was not cancelled (a plain unmount cleanup would have been).
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("cancels once on a real unmount", async () => {
    const onCancel = vi.fn()
    const { unmount } = render(<StrictMode><Run onCancel={onCancel} mounted={() => {}} /></StrictMode>)
    await tick()
    unmount()
    await tick()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
