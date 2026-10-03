import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBfcacheGuardForTests, installBfcacheGuard, trackLeaderWorker } from "./bfcache-guard"

const pageEvent = (type: "pagehide" | "pageshow", persisted: boolean): Event => {
  const event = new Event(type)
  Object.defineProperty(event, "persisted", { value: persisted })
  return event
}

const setup = () => {
  const target = new EventTarget() as unknown as Window
  const reload = vi.fn()
  const worker = { terminate: vi.fn() }
  trackLeaderWorker(worker as unknown as Worker)
  installBfcacheGuard({ target, reload })
  return { target, reload, worker }
}

beforeEach(() => {
  __resetBfcacheGuardForTests()
})

describe("installBfcacheGuard", () => {
  it("terminates the leader when the page enters the bfcache", () => {
    const { target, worker } = setup()
    target.dispatchEvent(pageEvent("pagehide", true))
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it("leaves the leader alone on an ordinary pagehide (reload, quit)", () => {
    const { target, worker } = setup()
    target.dispatchEvent(pageEvent("pagehide", false))
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it("reloads a page restored from the bfcache after its leader was terminated", () => {
    const { target, reload } = setup()
    target.dispatchEvent(pageEvent("pagehide", true))
    target.dispatchEvent(pageEvent("pageshow", true))
    expect(reload).toHaveBeenCalledOnce()
  })

  it("does not reload on a normal page load", () => {
    const { target, reload } = setup()
    target.dispatchEvent(pageEvent("pageshow", false))
    expect(reload).not.toHaveBeenCalled()
  })

  it("installs its listeners only once", () => {
    const { target, worker } = setup()
    installBfcacheGuard({ target })
    target.dispatchEvent(pageEvent("pagehide", true))
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
