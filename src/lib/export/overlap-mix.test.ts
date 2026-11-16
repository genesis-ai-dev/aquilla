// AQU-2432 (Sam, Nov 6, rule 7): an export joining takes end to end lays a
// take dragged over the end of the one before it where playback starts it, and
// sums the two there — both at full volume, held at full scale.

import { describe, expect, it } from "vitest"
import { mixPcm, mixPlaces, Pcm16Mixer } from "./overlap-mix"

const f32 = (...v: number[]) => new Float32Array(v)
const blob16 = (...v: number[]) => new Blob([new Int16Array(v)])
const read16 = async (parts: Blob[]) => [...new Int16Array(await new Blob(parts).arrayBuffer())]

describe("mixPlaces / mixPcm", () => {
  it("end to end with no overlap, as before", () => {
    expect([...mixPcm([{ audio: f32(1, 1), overlap: 0 }, { audio: f32(2), overlap: 0 }])]).toEqual([1, 1, 2])
  })

  it("a part over the end of the one before it is summed there", () => {
    expect([...mixPcm([{ audio: f32(1, 1, 1, 1), overlap: 0 }, { audio: f32(2, 2, 2), overlap: 2 }])]).toEqual([1, 1, 3, 3, 2])
  })

  it("a chain: a short part inside a long one, and the next one after it, still under the long one", () => {
    const { at, total } = mixPlaces([{ length: 10, overlap: 0 }, { length: 2, overlap: 8 }, { length: 3, overlap: 0 }])
    expect(at).toEqual([0, 2, 4])
    expect(total).toBe(10)
  })

  it("never before the start of the file", () => {
    expect(mixPlaces([{ length: 2, overlap: 5 }]).at).toEqual([0])
  })
})

describe("Pcm16Mixer", () => {
  it("hands on parts that follow one another as the blobs they are", async () => {
    const a = blob16(1, 2)
    const b = blob16(3)
    const m = new Pcm16Mixer()
    await m.push(a, 2, 0)
    await m.push(b, 1, 0)
    const out = m.finish()
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
    expect(m.samples).toBe(3)
  })

  it("mixes a part over the end of the one before it, and the one after both", async () => {
    const m = new Pcm16Mixer()
    await m.push(blob16(10, 10, 10, 10), 4, 0)
    await m.push(blob16(1, 1, 1), 3, 2)
    await m.push(blob16(5), 1, 0)
    expect(await read16(m.finish())).toEqual([10, 10, 11, 11, 1, 5])
  })

  it("mixes a part that starts while a long one before it still runs on", async () => {
    const m = new Pcm16Mixer()
    await m.push(blob16(10, 10, 10, 10, 10, 10), 6, 0)
    await m.push(blob16(1), 1, 5) // at 1, inside the long one
    await m.push(blob16(2, 2), 2, 0) // right after it, at 2: still inside
    expect(await read16(m.finish())).toEqual([10, 11, 12, 12, 10, 10])
  })

  it("holds the sum at full scale", async () => {
    const m = new Pcm16Mixer()
    await m.push(blob16(30000, -30000), 2, 0)
    await m.push(blob16(30000, -30000), 2, 2)
    expect(await read16(m.finish())).toEqual([32767, -32768])
  })
})
