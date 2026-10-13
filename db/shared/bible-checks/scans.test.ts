// AQU-1697: the file-level Bible data scans, S1 (a heading where each passage
// starts) and S8 (the file's verses against the pack's), on real pack data
// (John 2, trimmed in __fixtures__/pack-a.ts).
//
// WHY: a heading that is missing where a passage starts, or that cuts a
// passage in two, misleads a reader about where a story begins. A file that
// numbers verses differently from the pack gets every verse fact on the
// wrong cell, so the translator must hear about it once, in Check file.

import { describe, expect, it } from 'vitest'
import { JHN_A_STRUCTURE } from './__fixtures__/pack-a'
import { scanHeadings, scanVersification, type ScanCellInput } from './scans'

const verse = (ref: string): ScanCellInput => ({ id: ref, type: 'text', globalReferences: [ref] })
const heading = (id: string, ref = `JHN 2:s1:${id}`): ScanCellInput => ({ id, type: 'heading', globalReferences: [ref] })
const chapter2 = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => verse(`JHN 2:${from + i}`))
const PERICOPE = { headings: 'pericope' as const }

describe('S1: a heading where each passage starts', () => {
  it('finds the missing heading at JHN 2:13, where "The Purging of the Temple" starts', () => {
    const cells = [heading('h1'), ...chapter2(1, 25)]
    expect(scanHeadings(cells, JHN_A_STRUCTURE, PERICOPE)).toEqual([
      expect.objectContaining({
        cellId: 'JHN 2:13',
        code: 'bkp:S1',
        reason: 'heading-missing',
        severity: 'info',
        evidence: { kind: 'pericope', refs: ['JHN 2:13'], title: 'The Purging of the Temple and Its Results' },
      }),
    ])
  })

  it('passes a heading before each passage', () => {
    const cells = [heading('h1'), ...chapter2(1, 12), heading('h2'), ...chapter2(13, 25)]
    expect(scanHeadings(cells, JHN_A_STRUCTURE, PERICOPE)).toEqual([])
  })

  it('flags a heading inside a passage, on the heading', () => {
    const cells = [heading('h1'), ...chapter2(1, 4), heading('h2'), ...chapter2(5, 12), heading('h3'), ...chapter2(13, 25)]
    expect(scanHeadings(cells, JHN_A_STRUCTURE, PERICOPE)).toEqual([
      expect.objectContaining({ cellId: 'h2', reason: 'heading-inside-pericope', evidence: expect.objectContaining({ title: 'The Marriage at Cana' }) }),
    ])
  })

  it('does not take a parallel-passage reference (\\r) for a section heading', () => {
    const cells = [heading('h1'), ...chapter2(1, 12), heading('r1', 'JHN 2:r:1'), ...chapter2(13, 25)]
    expect(scanHeadings(cells, JHN_A_STRUCTURE, PERICOPE).map((f) => f.cellId)).toEqual(['JHN 2:13'])
  })

  it('asks nothing of a project without headings', () => {
    expect(scanHeadings(chapter2(1, 25), JHN_A_STRUCTURE, { headings: 'none' })).toEqual([])
    expect(scanHeadings(chapter2(1, 25), JHN_A_STRUCTURE, {})).toEqual([])
  })
})

describe('S8: the file numbers its verses as the pack does', () => {
  // The pack's verse set for 3 John (BKP 1.1.0): 15 verses, where English
  // Bibles have 14 and put verse 15's words in verse 14.
  const THIRD_JOHN = {
    verses: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`3JN 1:${i + 1}`, { question: false }])),
  }

  it('reports the pack verse with no cell (3JN 1:15) on the cell before it', () => {
    const cells = Array.from({ length: 14 }, (_, i) => verse(`3JN 1:${i + 1}`))
    expect(scanVersification(cells, THIRD_JOHN)).toEqual([
      expect.objectContaining({
        cellId: '3JN 1:14',
        code: 'bkp:S8',
        reason: 'pack-verse-without-cell',
        evidence: { kind: 'versification', refs: ['3JN 1:15'] },
      }),
    ])
  })

  it('reports a cell whose verse the pack lacks, but leaves textual variants to S6', () => {
    const cells = [...Array.from({ length: 15 }, (_, i) => verse(`3JN 1:${i + 1}`)), verse('3JN 1:16')]
    expect(scanVersification(cells, THIRD_JOHN).map((f) => [f.cellId, f.reason])).toEqual([['3JN 1:16', 'verse-not-in-pack']])
    const matthew = { verses: { 'MAT 17:20': { question: false }, 'MAT 17:22': { question: false } } }
    expect(scanVersification([verse('MAT 17:20'), verse('MAT 17:21'), verse('MAT 17:22')], matthew)).toEqual([])
  })

  it('checks only the chapters the file has', () => {
    expect(scanVersification(chapter2(1, 25), JHN_A_STRUCTURE)).toEqual([])
  })
})
