// The warmer's manners matrix. The absent-API row is load-bearing: Safari,
// Firefox, node tests and the localhost browser gates all lack
// navigator.connection and must warm at full speed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { QueueState } from "./play-queue"

const queueState = vi.hoisted(() => ({ value: { kind: "idle" } as QueueState }))
vi.mock("./play-queue", () => ({ getQueueState: () => queueState.value }))

import { warmGate } from "./warm-policy"

type NavWithConnection = Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }

function setConnection(conn: { saveData?: boolean; effectiveType?: string } | undefined): void {
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    get: () => conn,
  })
}

describe("warmGate", () => {
  beforeEach(() => {
    queueState.value = { kind: "idle" }
  })
  afterEach(() => {
    delete (navigator as NavWithConnection & { connection?: unknown }).connection
  })

  it("absent API → full speed (the localhost/Safari/Firefox row)", () => {
    expect(warmGate()).toEqual({ kind: "go", maxWorkers: Number.POSITIVE_INFINITY })
  })

  it("saveData (metered) → stop, and it outranks everything", () => {
    setConnection({ saveData: true, effectiveType: "4g" })
    queueState.value = { kind: "loading", cellIndex: 0, cellId: "c" }
    expect(warmGate()).toEqual({ kind: "stop", reason: "metered" })
  })

  it("2g-class links → stop", () => {
    setConnection({ effectiveType: "2g" })
    expect(warmGate()).toEqual({ kind: "stop", reason: "slow" })
    setConnection({ effectiveType: "slow-2g" })
    expect(warmGate()).toEqual({ kind: "stop", reason: "slow" })
  })

  it("live playback loading → wait (playback always wins)", () => {
    setConnection({ effectiveType: "4g" })
    queueState.value = { kind: "loading", cellIndex: 0, cellId: "c" }
    expect(warmGate()).toEqual({ kind: "wait" })
  })

  it("playing → one worker (it may be streaming invisibly)", () => {
    setConnection({ effectiveType: "4g" })
    queueState.value = { kind: "playing", cellIndex: 0, cellId: "c" }
    expect(warmGate()).toEqual({ kind: "go", maxWorkers: 1 })
  })

  it("3g → one worker even when idle", () => {
    setConnection({ effectiveType: "3g" })
    expect(warmGate()).toEqual({ kind: "go", maxWorkers: 1 })
  })

  it("4g and idle → full speed", () => {
    setConnection({ effectiveType: "4g" })
    expect(warmGate()).toEqual({ kind: "go", maxWorkers: Number.POSITIVE_INFINITY })
  })
})
