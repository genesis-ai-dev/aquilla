// AQU-1282: the restrictive-direction rule for the ten policy settings keys.
//
// Every policy key gets BOTH directions asserted here — the tightening write
// that is now admitted, and the loosening write that must still be refused.
// The table is the readable statement of the rule; the suites under it cover
// the edges the table cannot (unset defaults, cleared keys, values this build
// does not recognise, and the "safe answer is refuse" fallbacks).

import { describe, it, expect } from 'vitest'
import { evaluatePolicyWrite, POLICY_DIRECTION_RULES } from '../external/policy-direction'
import { POLICY_SETTINGS_KEYS } from '../external/commands-patch-settings'
import { PROJECT_SETTINGS_KEY_SPECS } from '../../../db/shared/project-settings-keys'

/** One policy key's two directions: from `current`, `tighten` is admitted and
 *  `loosen` is refused. */
interface DirectionCase {
  key: string
  current: unknown
  tighten: unknown
  loosen: unknown
}

const CASES: DirectionCase[] = [
  // The two the IBT Siberian Tatar setup needed a human for.
  { key: 'contributeToGlobalTm', current: true, tighten: false, loosen: true },
  { key: 'agentAuthorship', current: null, tighten: 'none', loosen: null },

  { key: 'allowSelfValidation', current: true, tighten: false, loosen: true },
  { key: 'agentMemoryAutonomy', current: 'agent-low-risk', tighten: 'human', loosen: 'agent-low-risk' },
  { key: 'validationRoleFloor', current: 'reviewer', tighten: 'maintainer', loosen: 'reviewer' },
  { key: 'harmonize_min_role', current: 'project_lead', tighten: 'maintainer', loosen: 'project_lead' },
  { key: 'validationCount', current: 3, tighten: 5, loosen: 2 },
  { key: 'validationCountAudio', current: 2, tighten: 4, loosen: 1 },
  { key: 'validationNamedUsers', current: ['ana'], tighten: ['ana', 'bo'], loosen: [] },
  // Absent/"none" is this key's STRICTEST rung (it admits nobody), so the
  // tightening move is back toward "none" and naming any tier is a loosening.
  { key: 'cellEditingFloor', current: 'maintainer', tighten: 'none', loosen: 'contributor' },
]

describe('policy keys — both directions, every key (AQU-1282)', () => {
  it('the case table covers every policy key', () => {
    expect(CASES.map((c) => c.key).sort()).toEqual([...POLICY_SETTINGS_KEYS].sort())
  })

  it.each(CASES)('$key: the restrictive write is admitted', ({ key, current, tighten }) => {
    expect(evaluatePolicyWrite(key, tighten, current)).toEqual({ ok: true })
  })

  it.each(CASES)('$key: the loosening write is refused', ({ key, tighten, loosen }) => {
    // Loosen FROM the tightened value, so each case is a real reversal of the
    // move admitted above rather than a no-op against the starting value.
    const verdict = evaluatePolicyWrite(key, loosen, tighten)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain(key)
  })

  it.each(CASES)('$key: re-writing the value it already holds is a no-op, not a denial', ({ key, current }) => {
    expect(evaluatePolicyWrite(key, current, current)).toEqual({ ok: true })
  })
})

describe('policy direction — unset and cleared keys', () => {
  it('an unset key compares as its real default, not as a hole', () => {
    // contributeToGlobalTm defaults to true (only `=== false` opts out), so
    // unset → false is the tightening the pilot project needed.
    expect(evaluatePolicyWrite('contributeToGlobalTm', false, undefined)).toEqual({ ok: true })
    // allowSelfValidation defaults to true (ProjectSettings.tsx baseline).
    expect(evaluatePolicyWrite('allowSelfValidation', false, undefined)).toEqual({ ok: true })
    // validationRoleFloor defaults to "reviewer", the bottom rung.
    expect(evaluatePolicyWrite('validationRoleFloor', 'project_lead', undefined)).toEqual({ ok: true })
    // harmonize_min_role defaults to project_lead (AQU-186's hard floor).
    expect(evaluatePolicyWrite('harmonize_min_role', 'maintainer', undefined)).toEqual({ ok: true })
    // agentMemoryAutonomy defaults to "human" — already the strict rung, so
    // there is nothing to tighten and the loose value is refused.
    expect(evaluatePolicyWrite('agentMemoryAutonomy', 'agent-low-risk', undefined).ok).toBe(false)
  })

  it('clearing a key reads as its default, so clearing a tightened key is a loosening', () => {
    expect(evaluatePolicyWrite('agentAuthorship', null, 'none').ok).toBe(false)
    expect(evaluatePolicyWrite('contributeToGlobalTm', null, false).ok).toBe(false)
    expect(evaluatePolicyWrite('allowSelfValidation', null, false).ok).toBe(false)
    expect(evaluatePolicyWrite('validationCount', null, 5).ok).toBe(false)
    // Clearing validationNamedUsers drops every named signer.
    expect(evaluatePolicyWrite('validationNamedUsers', null, ['ana']).ok).toBe(false)
  })

  it('cellEditingFloor: absent and "none" are one rung, so neither way round is a move', () => {
    expect(evaluatePolicyWrite('cellEditingFloor', 'none', undefined)).toEqual({ ok: true })
    expect(evaluatePolicyWrite('cellEditingFloor', null, 'none')).toEqual({ ok: true })
    // ...and every tier is still a loosening off that rung.
    for (const tier of ['commenter', 'reviewer', 'contributor', 'project_lead', 'maintainer']) {
      expect(evaluatePolicyWrite('cellEditingFloor', tier, undefined).ok, tier).toBe(false)
    }
  })
})

describe('policy direction — the safe answer is always refuse', () => {
  it('a value this build does not recognise is refused, in either position', () => {
    expect(evaluatePolicyWrite('validationRoleFloor', 'owner', 'reviewer').ok).toBe(false)
    expect(evaluatePolicyWrite('cellEditingFloor', 'superuser', 'maintainer').ok).toBe(false)
    // An unrankable CURRENT value refuses too: a blob this build cannot read is
    // not one it can prove a write tightens.
    expect(evaluatePolicyWrite('validationRoleFloor', 'maintainer', 'archivist').ok).toBe(false)
    expect(evaluatePolicyWrite('validationNamedUsers', ['ana'], 'ana').ok).toBe(false)
  })

  it('a wrong-typed proposal is refused rather than coerced', () => {
    expect(evaluatePolicyWrite('contributeToGlobalTm', 'false', true).ok).toBe(false)
    expect(evaluatePolicyWrite('validationCount', '9', 3).ok).toBe(false)
    expect(evaluatePolicyWrite('validationCount', Number.NaN, 3).ok).toBe(false)
    expect(evaluatePolicyWrite('validationNamedUsers', ['ana', 7], ['ana']).ok).toBe(false)
  })

  it('a key with no direction rule is refused, never defaulted to allowed', () => {
    expect(evaluatePolicyWrite('someFutureOversightKey', 1, 0).ok).toBe(false)
  })

  it('validationCount ranks on the CLAMPED value normalizeSettings actually stores', () => {
    // 20 clamps to 15, so proposing it over a stored 15 is a no-op, not a raise
    // — and proposing it over a stored 15 must not read as a loosening either.
    expect(evaluatePolicyWrite('validationCount', 20, 15)).toEqual({ ok: true })
    // Below the floor of 1 clamps UP to 1, so it cannot sneak under a stored 1.
    expect(evaluatePolicyWrite('validationCount', 0, 1)).toEqual({ ok: true })
    expect(evaluatePolicyWrite('validationCount', 0, 3).ok).toBe(false)
  })
})

describe('policy direction — registry agreement', () => {
  it('every policy key has a direction rule (a new one cannot default to allowed)', () => {
    expect(Object.keys(POLICY_DIRECTION_RULES).sort()).toEqual([...POLICY_SETTINGS_KEYS].sort())
  })

  it('every policy key is type-checked by the settings registry', () => {
    // Policy values used to skip validateSettingsKeyValue (they always resolved
    // to permission_denied). Now that they are writable, a mistyped policy
    // value must read as the typo it is — which needs a spec for every key.
    for (const key of POLICY_SETTINGS_KEYS) {
      expect(PROJECT_SETTINGS_KEY_SPECS[key], `no settings spec for policy key "${key}"`).toBeDefined()
    }
  })
})
