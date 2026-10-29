import { describe, expect, it } from "vitest"
import type { ProbeResult } from "../src/probe"
import { applyResults, evaluate, initialState, type TargetState, type Thresholds } from "../src/state"

const T: Thresholds = { failureThreshold: 3, recoveryThreshold: 2, reminderMinutes: 60 }
const MIN = 60_000
const ok: ProbeResult = { id: "sync", ok: true, status: 200, latencyMs: 40 }
const bad: ProbeResult = { id: "sync", ok: false, status: 503, latencyMs: 90, error: "HTTP 503 (expected 200)" }

/** Feeds results one minute apart and collects the alerts. */
function run(sequence: ProbeResult[], start: TargetState = initialState(0)) {
  let state = start
  const events: string[] = []
  sequence.forEach((result, i) => {
    const out = evaluate(state, result, T, (i + 1) * MIN)
    state = out.next
    if (out.event) events.push(`${out.event.kind}@${i + 1}`)
  })
  return { state, events }
}

describe("evaluate", () => {
  it("turns a new target up silently on its first good check", () => {
    const { state, events } = run([ok])
    expect(state.status).toBe("up")
    expect(events).toEqual([])
  })

  it("does not page for fewer failures than the threshold", () => {
    const { state, events } = run([ok, bad, bad, ok, bad, bad, ok])
    expect(state.status).toBe("up")
    expect(events).toEqual([])
  })

  it("pages once on the third failure in a row, not on every failure", () => {
    const { state, events } = run([ok, bad, bad, bad, bad, bad])
    expect(state.status).toBe("down")
    expect(events).toEqual(["down@4"])
  })

  it("dates the outage from the first failure, not from the alert", () => {
    let state = run([ok]).state
    let downSince: number | undefined
    for (let i = 2; i <= 4; i++) {
      const out = evaluate(state, bad, T, i * MIN)
      state = out.next
      if (out.event) downSince = out.event.downSince
    }
    expect(downSince).toBe(2 * MIN)
  })

  it("alerts when a target is failing from the very first check", () => {
    expect(run([bad, bad, bad]).events).toEqual(["down@3"])
  })

  it("recovers only after two good checks in a row, and reports the downtime", () => {
    let state = run([ok, bad, bad, bad]).state
    let out = evaluate(state, ok, T, 10 * MIN)
    expect(out.event).toBeUndefined()
    expect(out.next.status).toBe("down")
    state = out.next
    out = evaluate(state, ok, T, 11 * MIN)
    expect(out.next.status).toBe("up")
    expect(out.event?.kind).toBe("recovered")
    expect(out.event?.downSince).toBe(2 * MIN)
  })

  it("keeps the outage start when one good check interrupts the failures", () => {
    const { state, events } = run([ok, bad, bad, bad, ok, bad, ok, ok])
    expect(events).toEqual(["down@4", "recovered@8"])
    expect(state.status).toBe("up")
  })

  it("reminds every reminderMinutes while a target stays down", () => {
    const sequence = Array.from({ length: 130 }, () => bad)
    const { events } = run(sequence)
    expect(events).toEqual(["down@3", "reminder@63", "reminder@123"])
  })

  it("never reminds when reminderMinutes is 0", () => {
    let state = initialState(0)
    const kinds: string[] = []
    for (let i = 1; i <= 200; i++) {
      const out = evaluate(state, bad, { ...T, reminderMinutes: 0 }, i * MIN)
      state = out.next
      if (out.event) kinds.push(out.event.kind)
    }
    expect(kinds).toEqual(["down"])
  })

  it("records the latest check details for /status", () => {
    const { state } = run([ok, bad])
    expect(state).toMatchObject({ lastHttpStatus: 503, lastLatencyMs: 90, lastError: "HTTP 503 (expected 200)", failures: 1 })
  })
})

describe("applyResults", () => {
  it("drops state for targets no longer configured", () => {
    const stored = { old: initialState(0), sync: initialState(0) }
    const { states } = applyResults(stored, [ok], T, MIN)
    expect(Object.keys(states)).toEqual(["sync"])
  })

  it("returns one event per target that changed state", () => {
    const down = run([bad, bad, bad]).state
    const { events } = applyResults(
      { sync: down, web: initialState(0) },
      [ok, { ...ok, id: "web" }],
      { ...T, recoveryThreshold: 1 },
      10 * MIN,
    )
    expect(events.map((e) => `${e.kind}:${e.targetId}`)).toEqual(["recovered:sync"])
  })
})
