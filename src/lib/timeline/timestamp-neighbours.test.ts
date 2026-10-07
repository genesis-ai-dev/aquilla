import { describe, expect, it, vi } from "vitest"
import { timestampNeighbours } from "./timestamp-neighbours"

describe("timestamp neighbour reads", () => {
  it("does not walk a large file when the timestamp control is absent", () => {
    const getCellView = vi.fn(() => null)
    const ids = Array.from({ length: 31_215 }, (_, i) => String(i))
    for (const index of [0, 15_000, 31_214]) {
      expect(timestampNeighbours(index, ids, { getCellView }, false))
        .toEqual({ prevStartSec: null, nextStartSec: null })
    }
    expect(getCellView).not.toHaveBeenCalled()
  })

  it("walks past untimed rows, stops at the closest starts, and preserves zero", () => {
    const times = new Map([['a', 0], ['c', 12], ['f', 30]])
    const getCellView = vi.fn((id: string) => ({ startTime: times.get(id) }))
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(timestampNeighbours(2, ids, { getCellView }, true))
      .toEqual({ prevStartSec: 0, nextStartSec: 30 })
    expect(getCellView.mock.calls.map(([id]) => id)).toEqual(['b', 'a', 'd', 'e', 'f'])
    expect(timestampNeighbours(0, ids, { getCellView }, true))
      .toEqual({ prevStartSec: null, nextStartSec: 12 })
    expect(timestampNeighbours(5, ids, { getCellView }, true))
      .toEqual({ prevStartSec: 12, nextStartSec: null })
  })

  it("uses current display order and current timing values after a retime", () => {
    const times = new Map([['a', 3], ['b', 6], ['c', 9]])
    const store = { getCellView: (id: string) => ({ startTime: times.get(id) }) }
    expect(timestampNeighbours(1, ['c', 'b', 'a'], store, true))
      .toEqual({ prevStartSec: 9, nextStartSec: 3 })
    times.set('c', 5)
    expect(timestampNeighbours(1, ['a', 'c', 'b'], store, true))
      .toEqual({ prevStartSec: 3, nextStartSec: 6 })
    expect(timestampNeighbours(0, ['a', 'c', 'b'], store, true))
      .toEqual({ prevStartSec: null, nextStartSec: 5 })
  })
})
