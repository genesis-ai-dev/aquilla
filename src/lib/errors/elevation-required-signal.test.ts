/**
 * The step-up signal: one latched prompt that remembers WHAT was refused (so it
 * can word its "Verified" step), and a grant event that names the projects
 * whose sync-token mint was refused (so their pages can reload).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearElevationRequired,
  getElevationWaitingOn,
  isElevationRequired,
  notifyElevationGranted,
  notifyElevationRequired,
  onElevationGranted,
  onElevationRequired,
} from "./elevation-required-signal"

function resetSignal() {
  clearElevationRequired()
  // A grant consumes the refused-project set; nothing listens between tests.
  notifyElevationGranted()
}

beforeEach(resetSignal)
afterEach(resetSignal)

describe("elevation-required signal: what the prompt is waiting on", () => {
  it("is null until raised, and an unspecified raise is an action", () => {
    expect(getElevationWaitingOn()).toBeNull()
    notifyElevationRequired()
    expect(isElevationRequired()).toBe(true)
    expect(getElevationWaitingOn()).toBe("action")
  })

  it("records a sync-token refusal", () => {
    notifyElevationRequired({ kind: "sync-token", projectId: "p1" })
    expect(getElevationWaitingOn()).toBe("sync-token")
  })

  it("widens to both when the other kind lands while latched, and tells subscribers once", () => {
    const changed = vi.fn()
    const unsubscribe = onElevationRequired(changed)
    notifyElevationRequired({ kind: "sync-token", projectId: "p1" })
    notifyElevationRequired({ kind: "sync-token", projectId: "p2" })
    expect(changed).toHaveBeenCalledTimes(1)
    notifyElevationRequired({ kind: "action" })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(getElevationWaitingOn()).toBe("both")
    notifyElevationRequired({ kind: "action" })
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it("forgets the kinds when the prompt closes", () => {
    notifyElevationRequired({ kind: "action" })
    notifyElevationRequired({ kind: "sync-token", projectId: "p1" })
    clearElevationRequired()
    expect(getElevationWaitingOn()).toBeNull()
    notifyElevationRequired({ kind: "sync-token", projectId: "p1" })
    expect(getElevationWaitingOn()).toBe("sync-token")
  })
})

describe("elevation-granted event: which projects to reload", () => {
  it("names every project whose sync-token mint was refused, then consumes them", () => {
    const granted = vi.fn()
    const unsubscribe = onElevationGranted(granted)
    notifyElevationRequired({ kind: "sync-token", projectId: "p1" })
    notifyElevationRequired({ kind: "action" })
    notifyElevationRequired({ kind: "sync-token", projectId: "p2" })

    notifyElevationGranted()
    expect(granted).toHaveBeenCalledTimes(1)
    expect([...granted.mock.calls[0][0]].sort()).toEqual(["p1", "p2"])

    notifyElevationGranted()
    expect([...granted.mock.calls[1][0]]).toEqual([])
    unsubscribe()
  })

  it("keeps a refusal across a prompt closed unverified, so a later step-up still reloads it", () => {
    const granted = vi.fn()
    const unsubscribe = onElevationGranted(granted)
    notifyElevationRequired({ kind: "sync-token", projectId: "p1" })
    clearElevationRequired()

    notifyElevationGranted()
    expect([...granted.mock.calls[0][0]]).toEqual(["p1"])
    unsubscribe()
  })
})
