// AQU-1545: the ProjectSync DO's mirror-sync single-flight. A caller that
// arrives while a sync is running must be answered by a sync that STARTS after
// it asked — joining the running one answered a push frame for an upstream
// commit that landed mid-sync with a fold that had not seen it.

import { describe, it, expect } from "vitest"
import { createRerunSingleFlight } from "../lib/rerun-single-flight"

/** A run whose completion the test controls, recording when each started. */
function controllableRuns() {
  const started: number[] = []
  const finishers: Array<{ resolve: (v: number) => void; reject: (e: Error) => void }> = []
  let active = 0
  let maxActive = 0
  const run = (): Promise<number> => {
    const n = started.length + 1
    started.push(n)
    active++
    maxActive = Math.max(maxActive, active)
    return new Promise<number>((resolve, reject) => {
      finishers.push({
        resolve: (v) => {
          active--
          resolve(v)
        },
        reject: (e) => {
          active--
          reject(e)
        },
      })
    })
  }
  return { run, started, finishers, maxActive: () => maxActive }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("createRerunSingleFlight", () => {
  it("runs once for a lone caller", async () => {
    const r = controllableRuns()
    const request = createRerunSingleFlight(r.run)

    const p = request()
    r.finishers[0].resolve(1)

    await expect(p).resolves.toBe(1)
    expect(r.started).toEqual([1])
  })

  it("answers a caller that arrives mid-run with a run that starts after it asked", async () => {
    const r = controllableRuns()
    const request = createRerunSingleFlight(r.run)

    const first = request()
    const late = request() // the upstream changed after run 1 began
    expect(r.started).toEqual([1]) // never overlapping

    r.finishers[0].resolve(1)
    await expect(first).resolves.toBe(1)
    await tick()
    expect(r.started).toEqual([1, 2])

    r.finishers[1].resolve(2)
    await expect(late).resolves.toBe(2)
    expect(r.maxActive()).toBe(1)
  })

  it("shares one queued run among every caller that arrives mid-run", async () => {
    const r = controllableRuns()
    const request = createRerunSingleFlight(r.run)

    const first = request()
    const burst = [request(), request(), request(), request()]

    r.finishers[0].resolve(1)
    await first
    await tick()
    r.finishers[1].resolve(2)

    expect(await Promise.all(burst)).toEqual([2, 2, 2, 2])
    expect(r.started).toEqual([1, 2]) // a burst costs at most two runs
  })

  it("still runs the queued sync when the running one fails", async () => {
    const r = controllableRuns()
    const request = createRerunSingleFlight(r.run)

    const first = request()
    const late = request()

    r.finishers[0].reject(new Error("pg blip"))
    await expect(first).rejects.toThrow("pg blip")
    await tick()
    r.finishers[1].resolve(2)

    await expect(late).resolves.toBe(2)
  })

  it("starts fresh once everything has settled", async () => {
    const r = controllableRuns()
    const request = createRerunSingleFlight(r.run)

    const a = request()
    r.finishers[0].resolve(1)
    await a

    const b = request()
    expect(r.started).toEqual([1, 2])
    r.finishers[1].resolve(2)
    await expect(b).resolves.toBe(2)
  })

  it("passes the queued caller's arguments to the queued run", async () => {
    const seen: string[] = []
    let finish: (() => void) | null = null
    const request = createRerunSingleFlight(async (projectId: string) => {
      seen.push(projectId)
      await new Promise<void>((r) => { finish = r })
      return projectId
    })

    const a = request("proj-b")
    const b = request("proj-b")
    finish!()
    await a
    await tick()
    finish!()
    await b

    expect(seen).toEqual(["proj-b", "proj-b"])
  })
})
