// AQU-2425 — the "state the plan leaves behind" rule on its own.
//
// The five doors that can write the brief each answer the inert question from a
// different shape (a sole command, an op list, a whole blob), and the
// interesting cases are the ones where the plan changes the answer about
// itself. Those live here as one table; the per-door wiring is covered through
// the real prepare surfaces in external-mcp.test.ts and
// external-project-setup.test.ts.

import { describe, expect, it } from 'vitest'
import {
  BRIEF_INERT_WARNING_CODE,
  briefInertWarning,
  briefInertWarnings,
  briefWriteIsInert,
  plannedInstructionsOf,
  plannedInstructionsOfOps,
} from './brief-inert-warning'

const KEY = 'translationInstructions'

describe('briefWriteIsInert — asked of the state the plan leaves behind', () => {
  const cases: {
    name: string
    current: Record<string, unknown>
    planned?: string | null
    inert: boolean
  }[] = [
    {
      name: 'no instructions anywhere — the brief is what the prompts read',
      current: {},
      inert: false,
    },
    {
      name: 'instructions already saved — the brief reaches no prompt',
      current: { [KEY]: 'Formal register.' },
      inert: true,
    },
    {
      // storedTranslationInstructions treats a blank string as an explicit
      // "no instructions", which still beats the brief.
      name: 'instructions saved blank — an explicit "none" that still wins',
      current: { [KEY]: '' },
      inert: true,
    },
    {
      name: 'a plan that saves the instructions text strands its own brief',
      current: {},
      planned: 'Formal register.',
      inert: true,
    },
    {
      name: 'a whole-blob replace that DROPS the key hands the job back to the brief',
      current: { [KEY]: 'Formal register.' },
      planned: null,
      inert: false,
    },
    {
      name: 'a plan that neither reads nor writes the key defers to the live blob',
      current: { [KEY]: 'Formal register.' },
      planned: undefined,
      inert: true,
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(briefWriteIsInert(c.current, c.planned)).toBe(c.inert)
      expect(briefInertWarnings(c.current, c.planned)).toHaveLength(c.inert ? 1 : 0)
    })
  }

  it('tolerates a missing settings blob', () => {
    expect(briefWriteIsInert(null)).toBe(false)
    expect(briefWriteIsInert(undefined)).toBe(false)
  })
})

describe('reading the instructions a plan leaves stored', () => {
  it('a blob answers for itself — present, blank and absent', () => {
    expect(plannedInstructionsOf({ [KEY]: 'Formal.' })).toBe('Formal.')
    expect(plannedInstructionsOf({ [KEY]: '' })).toBe('')
    expect(plannedInstructionsOf({ targetLanguage: 'fr' })).toBeNull()
  })

  it('an op list that never names the key returns undefined, not null', () => {
    // The distinction matters: `null` would claim the plan UNSETS the key and
    // so revives the brief, which a patch on an unrelated key does not do.
    expect(plannedInstructionsOfOps([{ key: 'systemPrompt', value: 'x' }])).toBeUndefined()
    expect(plannedInstructionsOfOps([])).toBeUndefined()
    expect(plannedInstructionsOfOps(undefined)).toBeUndefined()
  })

  it('an op on the key answers with what it stores, last write winning', () => {
    expect(plannedInstructionsOfOps([{ key: KEY, value: 'Formal.' }])).toBe('Formal.')
    expect(
      plannedInstructionsOfOps([
        { key: KEY, value: 'first' },
        { key: KEY, value: 'second' },
      ]),
    ).toBe('second')
    // A non-string value is not a stored instruction.
    expect(plannedInstructionsOfOps([{ key: KEY, value: 42 }])).toBeNull()
  })
})

describe('the warning itself', () => {
  it('is settings-level and names the key that does reach the AI', () => {
    const w = briefInertWarning()
    expect(w.code).toBe(BRIEF_INERT_WARNING_CODE)
    expect(w.fileId).toBe('')
    expect(w.cellId).toBe('')
    expect(w.message).toContain(KEY)
    expect(w.message).toMatch(/will not reach the AI/i)
  })

  it('says WHY — a saved project, or this plan stranding its own write', () => {
    expect(briefInertWarning().message).toContain('this project has saved Instructions')
    expect(briefInertWarning('Formal.').message).toContain('this same change saves')
  })
})
