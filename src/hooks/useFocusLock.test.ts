// AQU-538 (slice 2): focus-lock key composer.
//
// The project Durable Object treats the lock key as an opaque string, so
// composing the active lane into the key gives per-lane leases without any
// server change. The default lane must compose to the bare cellId so N=1
// projects keep byte-identical on-wire keys and presence snapshots.

import { describe, it, expect } from "vitest"
import { focusLockKey, lockHolderForCell } from "./useFocusLock"

describe("focusLockKey (AQU-538)", () => {
  it("returns the bare cellId for the default lane ('')", () => {
    expect(focusLockKey("GEN 1:1", "")).toBe("GEN 1:1")
  })

  it("returns the bare cellId when lane is undefined", () => {
    expect(focusLockKey("GEN 1:1", undefined)).toBe("GEN 1:1")
  })

  it("qualifies the key with a non-default lane", () => {
    expect(focusLockKey("GEN 1:1", "es")).toBe("GEN 1:1@lane:es")
  })

  it("gives DISTINCT keys for the same cell in different lanes", () => {
    expect(focusLockKey("GEN 1:1", "es")).not.toBe(focusLockKey("GEN 1:1", "fr"))
  })

  it("gives the SAME key for the same cell + lane (co-editors contend)", () => {
    expect(focusLockKey("GEN 1:1", "es")).toBe(focusLockKey("GEN 1:1", "es"))
  })
})

describe("lockHolderForCell", () => {
  const holders = new Map([
    ["GEN 1:1", "alice"],
    ["GEN 1:1@lane:Swahili", "bob"],
  ])

  it("reads a default-lane lease by the bare cell id", () => {
    expect(lockHolderForCell(holders, "GEN 1:1", "")).toBe("alice")
    expect(lockHolderForCell(holders, "GEN 1:1", undefined)).toBe("alice")
  })

  it("reads a lane lease by the composed key", () => {
    expect(lockHolderForCell(holders, "GEN 1:1", "Swahili")).toBe("bob")
  })

  it("does not treat the default-lane lease as a named lane's", () => {
    expect(lockHolderForCell(new Map([["GEN 1:1", "alice"]]), "GEN 1:1", "Swahili")).toBeNull()
    expect(lockHolderForCell(holders, "GEN 1:1", "fr")).toBeNull()
  })

  it("returns null when there is no map", () => {
    expect(lockHolderForCell(null, "GEN 1:1", "Swahili")).toBeNull()
  })
})
