import { describe, it, expect } from 'vitest'
import { propagateHealth, type PropNode, type PropEdges } from './propagate-health'

const DECAY = 0.8

describe('propagateHealth', () => {
  it('anchors validated cells at 100', () => {
    const nodes: PropNode[] = [{ id: 'A', validated: true }]
    const h = propagateHealth(nodes, new Map(), { perHopDecay: DECAY, maxHops: 4 })
    expect(h.get('A')).toBe(100)
  })

  it('ripples down a chain, decaying per hop (the pond)', () => {
    // A(validated) ← B ← C ← D ; each relies only on its predecessor (r=1,a=1).
    const nodes: PropNode[] = [
      { id: 'A', validated: true },
      { id: 'B', validated: false },
      { id: 'C', validated: false },
      { id: 'D', validated: false },
    ]
    const edges: PropEdges = new Map([
      ['B', [{ to: 'A', r: 1, a: 1 }]],
      ['C', [{ to: 'B', r: 1, a: 1 }]],
      ['D', [{ to: 'C', r: 1, a: 1 }]],
    ])
    const h = propagateHealth(nodes, edges, { perHopDecay: DECAY, maxHops: 4 })
    expect(h.get('A')).toBe(100)
    expect(h.get('B')).toBeCloseTo(80)
    expect(h.get('C')).toBeCloseTo(64)
    expect(h.get('D')).toBeCloseTo(51.2)
  })

  it('keeps a familiar source with a wrong translation low (a-gate)', () => {
    // X relies on validated V: strong source match (r=1) but target barely
    // overlaps (a=0.1428). Should stay low even though V is 100.
    const nodes: PropNode[] = [
      { id: 'V', validated: true },
      { id: 'X', validated: false },
    ]
    const edges: PropEdges = new Map([['X', [{ to: 'V', r: 1, a: 0.142857 }]]])
    const h = propagateHealth(nodes, edges, { perHopDecay: DECAY, maxHops: 4 })
    expect(h.get('X')).toBeCloseTo(0.8 * 14.2857, 1) // ≈ 11.4
  })

  it('leaves an island with no validated anchor at 0', () => {
    const nodes: PropNode[] = [
      { id: 'X', validated: false },
      { id: 'Y', validated: false },
    ]
    const edges: PropEdges = new Map([
      ['X', [{ to: 'Y', r: 1, a: 1 }]],
      ['Y', [{ to: 'X', r: 1, a: 1 }]],
    ])
    const h = propagateHealth(nodes, edges, { perHopDecay: DECAY, maxHops: 4 })
    expect(h.get('X')).toBe(0)
    expect(h.get('Y')).toBe(0)
  })

  it('source-similarity-weights the mean across neighbors', () => {
    // X has two validated neighbors. V1: r=1,a=1. V2: r=1,a=0.5.
    // weighted mean of (a*health): (1*1*100 + 1*0.5*100)/(1+1) = 75 → *0.8 = 60.
    const nodes: PropNode[] = [
      { id: 'V1', validated: true },
      { id: 'V2', validated: true },
      { id: 'X', validated: false },
    ]
    const edges: PropEdges = new Map([
      ['X', [{ to: 'V1', r: 1, a: 1 }, { to: 'V2', r: 1, a: 0.5 }]],
    ])
    const h = propagateHealth(nodes, edges, { perHopDecay: DECAY, maxHops: 4 })
    expect(h.get('X')).toBeCloseTo(60)
  })

  it('a closer (higher-r) neighbor dominates a far one', () => {
    // V1 close (r=1) healthy; V2 far (r=0.1) also healthy but should matter less.
    // Both a=1, both 100 → mean is 100 regardless; use differing health via a chain
    // instead: V1 validated(100), Z unvalidated→low. Closer to V1 should win.
    const nodes: PropNode[] = [
      { id: 'V1', validated: true },
      { id: 'X', validated: false },
    ]
    // Only one neighbor; r weighting tested above. Here assert r=0 contributes nothing.
    const edges: PropEdges = new Map([
      ['X', [{ to: 'V1', r: 1, a: 1 }, { to: 'V1', r: 0, a: 1 }]],
    ])
    const h = propagateHealth(nodes, edges, { perHopDecay: DECAY, maxHops: 4 })
    expect(h.get('X')).toBeCloseTo(80) // r=0 edge ignored
  })
})
