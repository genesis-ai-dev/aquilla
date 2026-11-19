import { afterEach, describe, expect, it, vi } from "vitest"
import { warnLeader, type LeaderWarning } from "./leader-warnings"

/** Captures what the worker relays to the page. */
function captureRelayed(): LeaderWarning[] {
  const posted: LeaderWarning[] = []
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage(message: LeaderWarning) {
        posted.push(message)
      }
      close() {}
    },
  )
  return posted
}

describe("warnLeader", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("relays the error that stopped the leader, not just that it stopped", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const posted = captureRelayed()
    warnLeader("error", "leader worker stopped", new TypeError("OPFS handle lost"))
    expect(posted).toEqual([{ level: "error", text: "leader worker stopped: TypeError: OPFS handle lost" }])
  })

  it("relays plain text unchanged when there are no details", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const posted = captureRelayed()
    warnLeader("warn", "waiting for another leader")
    expect(posted).toEqual([{ level: "warn", text: "waiting for another leader" }])
  })

  it("turns non-Error details into text", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const posted = captureRelayed()
    warnLeader("warn", "odd failure", { code: 7 }, "extra")
    expect(posted).toEqual([{ level: "warn", text: 'odd failure: {"code":7} extra' }])
  })
})
