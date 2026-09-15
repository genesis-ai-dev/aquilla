// @vitest-environment node
import { describe, it, expect } from "vitest"
import { Pacer } from "../pacer"

function mk(over: Partial<ConstructorParameters<typeof Pacer>[0]> = {}) {
  let t = 0
  const sleeps: number[] = []
  const p = new Pacer({ eventsPerSec: 100, chunkStart: 500, chunkMin: 50, chunkMax: 2500, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms }, ...over })
  return { p, sleeps, tick: (ms: number) => { t += ms } }
}

describe("Pacer", () => {
  it("token bucket sleeps to respect events/sec", async () => {
    const { p, sleeps } = mk()
    await p.acquire(100)   // burst allowance = 1s of tokens
    await p.acquire(50)    // needs 0.5s more
    expect(sleeps).toEqual([500])
  })
  it("halves chunk on failure or slow response (floor) and doubles after 20 fast oks (cap)", () => {
    const { p } = mk()
    p.record({ ok: false, ms: 10 }); expect(p.chunkSize).toBe(250)
    p.record({ ok: true, ms: 5000 }); expect(p.chunkSize).toBe(125)
    for (let i = 0; i < 10; i++) p.record({ ok: false, ms: 1 })
    expect(p.chunkSize).toBe(50)
    for (let i = 0; i < 20; i++) p.record({ ok: true, ms: 100 })
    expect(p.chunkSize).toBe(100)
    for (let i = 0; i < 20 * 10; i++) p.record({ ok: true, ms: 100 })
    expect(p.chunkSize).toBe(2500)
  })
  it("pauses 30s after a failure and opens the breaker after 5 consecutive failures", async () => {
    const { p, sleeps, tick } = mk()
    for (let i = 0; i < 4; i++) p.record({ ok: false, ms: 1 })
    expect(p.paused).toBe(false)
    p.record({ ok: false, ms: 1 })
    expect(p.paused).toBe(true)
    const before = sleeps.length
    await p.acquire(1)
    expect(sleeps.slice(before).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(300_000)
    expect(p.paused).toBe(false)
    p.record({ ok: true, ms: 1 })
    tick(1)
    expect(p.snapshot().consecutiveFail).toBe(0)
  })
})
