// AQU-2192: the shared check table and the merge the Agent API's settings read
// uses. The SPA's registry consumes the same table, so one assertion here pins
// the contract both sides rely on.

import { describe, expect, it } from 'vitest'
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from '../../src/lib/lqa/builtin-registry'
import { resolveBuiltinRules } from '../../src/lib/lqa/builtin-resolver'
import { laneCheckOverrides } from '../../src/lib/lqa/lane-builtin-checks'
import { BIBLE_CHECK_IDS } from './bible-checks/types'
import {
  TEXT_CHECK_IDS,
  effectiveChecks,
  mergeLaneOverrides,
  type EffectiveCheck,
} from './builtin-checks'

const asRows = (rules: ReturnType<typeof resolveBuiltinRules>) =>
  rules.map((r) => ({ id: r.check.type === 'builtin' ? r.check.checkId : '', name: r.name, enabled: r.enabled, severity: r.severity }))
const pick = (rows: EffectiveCheck[]) => rows.map(({ id, name, enabled, severity }) => ({ id, name, enabled, severity }))

describe('shared built-in check table', () => {
  it('is what the SPA registry runs: same ids, order, names and defaults', () => {
    expect(BUILTIN_CHECK_IDS).toEqual([...TEXT_CHECK_IDS])
    for (const id of [...TEXT_CHECK_IDS, ...BIBLE_CHECK_IDS]) {
      const spa = BUILTIN_CHECKS[id]
      const shared = effectiveChecks({}, { bibleChecks: true }).find((c) => c.id === id)!
      expect([spa.name, spa.defaultEnabled, spa.defaultSeverity]).toEqual([shared.name, shared.enabled, shared.severity])
    }
  })

  it('lists the 18 text checks alone by default, plus the Bible checks when asked', () => {
    expect(effectiveChecks(undefined)).toHaveLength(18)
    expect(effectiveChecks(undefined).some((c) => c.id.startsWith('bkp:'))).toBe(false)
    expect(effectiveChecks(undefined, { bibleChecks: true })).toHaveLength(18 + BIBLE_CHECK_IDS.length)
  })

  it('resolves exactly as the Rules page does, for project and lane overrides', () => {
    const project = { 'usfm-structure': { enabled: false }, 'length-ratio': { enabled: true, severity: 'major' as const } }
    const byLane = { es: { 'usfm-structure': { enabled: true, severity: 'minor' as const }, capitalization: { enabled: false } } }
    for (const bibleChecks of [false, true]) {
      expect(pick(effectiveChecks(project, { bibleChecks }))).toEqual(asRows(resolveBuiltinRules(project, { bibleChecks })))
      const spaLane = laneCheckOverrides({ algorithmicChecks: project, algorithmicChecksByLane: byLane }, 'es')
      expect(pick(effectiveChecks(mergeLaneOverrides(project, byLane.es), { bibleChecks }))).toEqual(
        asRows(resolveBuiltinRules(spaLane, { bibleChecks })),
      )
    }
  })

  it('marks only the checks with an entry as overridden, and ignores damaged entries', () => {
    const rows = effectiveChecks({ 'double-space': { enabled: false }, 'repeated-word': 'off', nonsense: { enabled: false } })
    expect(rows.filter((c) => c.overridden).map((c) => c.id)).toEqual(['double-space'])
    expect(rows.find((c) => c.id === 'double-space')).toMatchObject({ enabled: false, severity: 'minor' })
  })

  it('lets a lane entry replace the project entry for that check only', () => {
    const merged = mergeLaneOverrides(
      { a: { enabled: false, severity: 'major' }, b: { enabled: false } },
      { a: { enabled: true } },
    )
    expect(merged).toEqual({ a: { enabled: true }, b: { enabled: false } })
  })
})
