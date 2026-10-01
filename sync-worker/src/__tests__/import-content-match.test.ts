import { describe, expect, it } from 'vitest'

import {
  classifyMatchBands,
  matchImportContent,
  normalizeForMatch,
  orderSourceCellsByAnchor,
  type ContentMatchCell,
  type MatchBand,
} from '../events/import-content-match'

const cells = (...values: string[]): ContentMatchCell[] =>
  values.map((value, index) => ({ cellId: `v-${index}`, value }))

const named = (entries: Record<string, string>): ContentMatchCell[] =>
  Object.entries(entries).map(([cellId, value]) => ({ cellId, value }))

/** Adopt, then label — the same two steps the planner runs, in the same order. */
function match(
  next: ContentMatchCell[],
  previous: ContentMatchCell[],
  locked: ReadonlyMap<string, string> = new Map(),
): { adopted: Map<string, { cellId: string; quality: string }>; bands: Map<string, MatchBand> } {
  const { adopted } = matchImportContent(next, previous, locked)
  const paired = new Map(locked)
  for (const [incomingId, adoption] of adopted) paired.set(incomingId, adoption.cellId)
  return { adopted, bands: classifyMatchBands(next, previous, paired) }
}

const bandsOf = (outcome: { bands: Map<string, MatchBand> }): MatchBand[] => [...outcome.bands.values()]

describe('normalizeForMatch', () => {
  it('collapses whitespace and trims but keeps case', () => {
    expect(normalizeForMatch('  The\n  Lord   said ')).toBe('The Lord said')
    expect(normalizeForMatch('the lord said')).not.toBe(normalizeForMatch('The Lord said'))
  })
})

describe('orderSourceCellsByAnchor', () => {
  const chain = [
    { cellId: 'c', anchorCellId: 'b' },
    { cellId: 'a', anchorCellId: null },
    { cellId: 'b', anchorCellId: 'a' },
  ]

  it('walks the anchor chain regardless of row order', () => {
    expect(orderSourceCellsByAnchor(chain).map((cell) => cell.cellId)).toEqual(['a', 'b', 'c'])
  })

  it('treats an anchor that is not in the file as a head', () => {
    const ordered = orderSourceCellsByAnchor([
      { cellId: 'y', anchorCellId: 'x' },
      { cellId: 'x', anchorCellId: 'gone' },
    ])
    expect(ordered.map((cell) => cell.cellId)).toEqual(['x', 'y'])
  })

  it('returns every cell exactly once when the chain cycles', () => {
    const ordered = orderSourceCellsByAnchor([
      { cellId: 'p', anchorCellId: 'q' },
      { cellId: 'q', anchorCellId: 'p' },
    ])
    expect(ordered.map((cell) => cell.cellId).sort()).toEqual(['p', 'q'])
  })

  it('keeps every cell when the chain forks', () => {
    const ordered = orderSourceCellsByAnchor([
      { cellId: 'root', anchorCellId: null },
      { cellId: 'left', anchorCellId: 'root' },
      { cellId: 'right', anchorCellId: 'root' },
    ])
    expect(ordered.map((cell) => cell.cellId).sort()).toEqual(['left', 'right', 'root'])
  })
})

describe('matchImportContent', () => {
  it('marks an untouched file as ICE end to end', () => {
    const previous = cells('One.', 'Two.', 'Three.')
    const next = named({ n0: 'One.', n1: 'Two.', n2: 'Three.' })
    const outcome = match(next, previous)
    expect(bandsOf(outcome)).toEqual(['ice', 'ice', 'ice'])
    expect([...outcome.adopted.values()].map((adoption) => adoption.cellId)).toEqual(['v-0', 'v-1', 'v-2'])
  })

  it('demotes the neighbours of an inserted paragraph to exact, not changed', () => {
    const previous = cells('One.', 'Two.', 'Three.')
    const next = named({ n0: 'One.', n1: 'Inserted.', n2: 'Two.', n3: 'Three.' })
    const outcome = match(next, previous)
    // "One." and "Two." both lost a neighbour; "Three." kept both of hers.
    expect(outcome.bands.get('n0')).toBe('exact')
    expect(outcome.bands.get('n1')).toBe('new')
    expect(outcome.bands.get('n2')).toBe('exact')
    expect(outcome.bands.get('n3')).toBe('ice')
    expect(outcome.adopted.get('n2')?.cellId).toBe('v-1')
    expect(outcome.adopted.has('n1')).toBe(false)
  })

  it('keeps ICE on units far from a deletion', () => {
    const previous = cells('A.', 'B.', 'C.', 'D.', 'E.')
    const next = named({ n0: 'A.', n1: 'B.', n2: 'D.', n3: 'E.' })
    const outcome = match(next, previous)
    expect(outcome.bands.get('n0')).toBe('ice')
    expect(outcome.bands.get('n1')).toBe('exact')
    expect(outcome.bands.get('n2')).toBe('exact')
    expect(outcome.bands.get('n3')).toBe('ice')
  })

  it('carries a moved block across the file', () => {
    const previous = cells('Intro.', 'Body one.', 'Body two.', 'Outro.')
    const next = named({ n0: 'Body one.', n1: 'Body two.', n2: 'Intro.', n3: 'Outro.' })
    const outcome = match(next, previous)
    // The moved pair keeps its internal context, so neither is a full ICE, but
    // both still adopt their old cell and carry their translation.
    expect(outcome.adopted.get('n0')?.cellId).toBe('v-1')
    expect(outcome.adopted.get('n1')?.cellId).toBe('v-2')
    expect(outcome.adopted.get('n2')?.cellId).toBe('v-0')
    // "Outro." never moved, but the paragraph in front of her did, so she is
    // 100% rather than 101% — exactly the reviewer signal ICE exists to give.
    expect(outcome.bands.get('n3')).toBe('exact')
  })

  it('pairs duplicated segments one-for-one instead of collapsing them', () => {
    const previous = cells('Same.', 'Filler.', 'Same.')
    const next = named({ n0: 'Same.', n1: 'Filler.', n2: 'Same.' })
    const outcome = match(next, previous)
    const adoptedIds = ['n0', 'n1', 'n2'].map((id) => outcome.adopted.get(id)?.cellId)
    expect(new Set(adoptedIds).size).toBe(3)
    expect(adoptedIds).toEqual(['v-0', 'v-1', 'v-2'])
  })

  it('leaves a surplus duplicate unmatched rather than reusing a cell', () => {
    const previous = cells('Same.')
    const next = named({ n0: 'Same.', n1: 'Same.' })
    const outcome = match(next, previous)
    const adopted = [...outcome.adopted.values()]
    expect(adopted).toHaveLength(1)
    expect(bandsOf(outcome).filter((band) => band === 'new')).toHaveLength(1)
  })

  it('never adopts a cell identity matching already claimed', () => {
    const previous = cells('Kept.', 'Kept.')
    const next = named({ n0: 'Kept.', n1: 'Kept.' })
    const outcome = match(next, previous, new Map([['n1', 'v-0']]))
    expect(outcome.adopted.get('n0')?.cellId).toBe('v-1')
    expect(outcome.adopted.has('n1')).toBe(false)
  })

  it('labels a pair by its source text, not by how it was paired', () => {
    const previous = cells('Old wording.', 'Stable.')
    const next = named({ n0: 'New wording.', n1: 'Stable.' })
    const bands = classifyMatchBands(next, previous, new Map([['n0', 'v-0'], ['n1', 'v-1']]))
    expect(bands.get('n0')).toBe('changed')
    // n1's previous neighbour changed underneath her, so she is 100%, not ICE.
    expect(bands.get('n1')).toBe('exact')
  })

  it('ignores whitespace reflow', () => {
    const previous = cells('One.', 'A   wrapped\nline.', 'Three.')
    const next = named({ n0: 'One.', n1: 'A wrapped line.', n2: 'Three.' })
    const outcome = match(next, previous)
    expect(bandsOf(outcome)).toEqual(['ice', 'ice', 'ice'])
  })

  it('never matches on a blank unit', () => {
    const previous = cells('', '', 'Real.')
    const next = named({ n0: '', n1: '   ', n2: 'Real.' })
    const outcome = match(next, previous)
    expect(outcome.adopted.has('n0')).toBe(false)
    expect(outcome.adopted.has('n1')).toBe(false)
    expect(outcome.bands.get('n0')).toBe('new')
    expect(outcome.bands.get('n2')).toBe('ice')
  })

  it('lets an unlocked pair be reclaimed by the unit whose text matches', () => {
    // v1: Alpha / Beta. v2 inserts a preface, so p0's key now names the
    // preface and p1's names Alpha. Only unlocked pairs are on offer, so
    // "Alpha." must be able to take cell v-0 back.
    const previous = cells('Alpha.', 'Beta.')
    const next = named({ n0: 'Preface.', n1: 'Alpha.', n2: 'Beta.' })
    const outcome = match(next, previous)
    expect(outcome.adopted.get('n1')?.cellId).toBe('v-0')
    expect(outcome.adopted.get('n2')?.cellId).toBe('v-1')
    expect(outcome.bands.get('n0')).toBe('new')
  })

  it('reports a band for every incoming unit', () => {
    const next = named({ n0: 'A.', n1: 'B.' })
    const outcome = match(next, cells('Z.'))
    expect([...outcome.bands.keys()].sort()).toEqual(['n0', 'n1'])
  })

  it('stays linear on a file that is almost entirely one repeated line', () => {
    // Guards the bucket cursor: consuming duplicates by shifting an array
    // would make this quadratic, and re-import allows up to 50k cells.
    const size = 20_000
    const previous = Array.from({ length: size }, (_, i) => ({ cellId: `old-${i}`, value: 'Amen.' }))
    const next = Array.from({ length: size }, (_, i) => ({ cellId: `new-${i}`, value: 'Amen.' }))
    const started = Date.now()
    const outcome = match(next, previous)
    expect(outcome.adopted.size).toBe(size)
    expect(new Set([...outcome.adopted.values()].map((adoption) => adoption.cellId)).size).toBe(size)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('treats a first version with nothing to match as all new', () => {
    const outcome = match(named({ n0: 'A.', n1: 'B.' }), [])
    expect(bandsOf(outcome)).toEqual(['new', 'new'])
    expect(outcome.adopted.size).toBe(0)
  })
})
