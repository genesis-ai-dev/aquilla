// AQU-1282 §1: pure unit coverage for the policy-key direction table. Every
// policy key gets one tightening and one loosening case, plus the unset →
// default reading and the null → "clear to default" reading, because those
// defaults are what decide whether an agent's first write on a fresh project
// lands. The HTTP-boundary coverage lives in external-patch-settings.test.ts.

import { describe, it, expect } from 'vitest'
import {
  POLICY_DIRECTION_TABLE,
  loosensPolicy,
  policyWriteDirection,
} from '../../../db/shared/policy-direction'
import { POLICY_SETTINGS_KEYS } from '../external/commands-patch-settings'

describe('policyWriteDirection — per-key table', () => {
  it('the direction table names every policy key exactly once', () => {
    expect(POLICY_DIRECTION_TABLE.map((r) => r.key).sort()).toEqual([...POLICY_SETTINGS_KEYS].sort())
  })

  it('a key outside the policy set is invalid, never silently tightening', () => {
    expect(policyWriteDirection('systemPrompt', undefined, 'x').direction).toBe('invalid')
  })

  describe('contributeToGlobalTm (unset ⇒ true)', () => {
    it('true → false tightens; unset → false tightens', () => {
      expect(policyWriteDirection('contributeToGlobalTm', true, false).direction).toBe('tighten')
      expect(policyWriteDirection('contributeToGlobalTm', undefined, false).direction).toBe('tighten')
    })
    it('false → true loosens; false → null (clear ⇒ true) loosens', () => {
      expect(policyWriteDirection('contributeToGlobalTm', false, true).direction).toBe('loosen')
      expect(policyWriteDirection('contributeToGlobalTm', false, null).direction).toBe('loosen')
    })
    it('true → true and unset → true are no-ops (tighten)', () => {
      expect(policyWriteDirection('contributeToGlobalTm', true, true).direction).toBe('tighten')
      expect(policyWriteDirection('contributeToGlobalTm', undefined, true).direction).toBe('tighten')
    })
    it('a non-boolean is invalid', () => {
      expect(policyWriteDirection('contributeToGlobalTm', true, 'no').direction).toBe('invalid')
    })
  })

  describe('agentAuthorship (unset ⇒ exposed)', () => {
    it('unset → "none" tightens; "none" → "none" is a no-op', () => {
      expect(policyWriteDirection('agentAuthorship', undefined, 'none').direction).toBe('tighten')
      expect(policyWriteDirection('agentAuthorship', 'none', 'none').direction).toBe('tighten')
    })
    it('"none" → null (the only way to clear) loosens', () => {
      expect(policyWriteDirection('agentAuthorship', 'none', null).direction).toBe('loosen')
    })
    it('unset → null is a no-op; any other string is invalid', () => {
      expect(policyWriteDirection('agentAuthorship', undefined, null).direction).toBe('tighten')
      expect(policyWriteDirection('agentAuthorship', undefined, 'full').direction).toBe('invalid')
    })
  })

  describe('allowSelfValidation (unset ⇒ true; only === false is off)', () => {
    it('unset → false tightens', () => {
      expect(policyWriteDirection('allowSelfValidation', undefined, false).direction).toBe('tighten')
    })
    it('false → true loosens; false → null loosens', () => {
      expect(policyWriteDirection('allowSelfValidation', false, true).direction).toBe('loosen')
      expect(policyWriteDirection('allowSelfValidation', false, null).direction).toBe('loosen')
    })
  })

  describe('agentMemoryAutonomy (unset ⇒ "human")', () => {
    it('"agent-low-risk" → "human" tightens; unset → "human" is a no-op', () => {
      expect(policyWriteDirection('agentMemoryAutonomy', 'agent-low-risk', 'human').direction).toBe('tighten')
      expect(policyWriteDirection('agentMemoryAutonomy', undefined, 'human').direction).toBe('tighten')
    })
    it('"human" → "agent-low-risk" loosens; unset → "agent-low-risk" loosens', () => {
      expect(policyWriteDirection('agentMemoryAutonomy', 'human', 'agent-low-risk').direction).toBe('loosen')
      expect(policyWriteDirection('agentMemoryAutonomy', undefined, 'agent-low-risk').direction).toBe('loosen')
    })
    it('"agent-low-risk" → "agent-low-risk" is a no-op; an unknown value is invalid', () => {
      expect(policyWriteDirection('agentMemoryAutonomy', 'agent-low-risk', 'agent-low-risk').direction).toBe('tighten')
      expect(policyWriteDirection('agentMemoryAutonomy', 'human', 'agent-full').direction).toBe('invalid')
    })
  })

  describe.each(['validationCount', 'validationCountAudio'])('%s (int ≥ 1; unset ⇒ 1)', (key) => {
    it('raising tightens; equal is a no-op; unset → 3 tightens', () => {
      expect(policyWriteDirection(key, 3, 5).direction).toBe('tighten')
      expect(policyWriteDirection(key, 3, 3).direction).toBe('tighten')
      expect(policyWriteDirection(key, undefined, 3).direction).toBe('tighten')
    })
    it('lowering loosens; 3 → null (clear ⇒ 1) loosens', () => {
      expect(policyWriteDirection(key, 3, 1).direction).toBe('loosen')
      expect(policyWriteDirection(key, 3, null).direction).toBe('loosen')
    })
    it('a non-integer or a value below 1 is invalid', () => {
      expect(policyWriteDirection(key, 3, 2.5).direction).toBe('invalid')
      expect(policyWriteDirection(key, 3, 0).direction).toBe('invalid')
      expect(policyWriteDirection(key, 3, '5').direction).toBe('invalid')
    })
    it('an unreadable stored value reads as the default (1)', () => {
      expect(policyWriteDirection(key, 'three', 1).direction).toBe('tighten')
    })
  })

  describe('validationRoleFloor (reviewer < project_lead < maintainer; unset ⇒ reviewer)', () => {
    it('a higher rung tightens; unset → maintainer tightens', () => {
      expect(policyWriteDirection('validationRoleFloor', 'reviewer', 'maintainer').direction).toBe('tighten')
      expect(policyWriteDirection('validationRoleFloor', undefined, 'project_lead').direction).toBe('tighten')
    })
    it('a lower rung loosens; maintainer → null (clear ⇒ reviewer) loosens', () => {
      expect(policyWriteDirection('validationRoleFloor', 'maintainer', 'project_lead').direction).toBe('loosen')
      expect(policyWriteDirection('validationRoleFloor', 'maintainer', null).direction).toBe('loosen')
    })
    it('a rung outside the ladder is invalid', () => {
      expect(policyWriteDirection('validationRoleFloor', 'reviewer', 'owner').direction).toBe('invalid')
    })
  })

  describe('harmonize_min_role (project_lead < maintainer; unset ⇒ project_lead)', () => {
    it('project_lead → maintainer tightens; unset → project_lead is a no-op', () => {
      expect(policyWriteDirection('harmonize_min_role', 'project_lead', 'maintainer').direction).toBe('tighten')
      expect(policyWriteDirection('harmonize_min_role', undefined, 'project_lead').direction).toBe('tighten')
    })
    it('maintainer → project_lead loosens', () => {
      expect(policyWriteDirection('harmonize_min_role', 'maintainer', 'project_lead').direction).toBe('loosen')
    })
  })

  describe('cellEditingFloor (commenter < … < maintainer < "none"; unset ⇒ "none")', () => {
    it('contributor → maintainer tightens (fewer people); contributor → "none" tightens', () => {
      expect(policyWriteDirection('cellEditingFloor', 'contributor', 'maintainer').direction).toBe('tighten')
      expect(policyWriteDirection('cellEditingFloor', 'contributor', 'none').direction).toBe('tighten')
    })
    it('unset (nobody) → any real tier loosens; maintainer → contributor loosens', () => {
      expect(policyWriteDirection('cellEditingFloor', undefined, 'maintainer').direction).toBe('loosen')
      expect(policyWriteDirection('cellEditingFloor', 'maintainer', 'contributor').direction).toBe('loosen')
    })
    it('unset → "none" and contributor → null (clear ⇒ nobody) are tightening', () => {
      expect(policyWriteDirection('cellEditingFloor', undefined, 'none').direction).toBe('tighten')
      expect(policyWriteDirection('cellEditingFloor', 'contributor', null).direction).toBe('tighten')
    })
    it('a tier this build does not know is invalid', () => {
      expect(policyWriteDirection('cellEditingFloor', 'none', 'owner').direction).toBe('invalid')
    })
  })

  describe('validationNamedUsers (allowlist; empty ⇒ anyone above the floor)', () => {
    it('empty → [a] tightens (only a may validate); [a, b] → [a] tightens (fewer validators)', () => {
      expect(policyWriteDirection('validationNamedUsers', undefined, ['a']).direction).toBe('tighten')
      expect(policyWriteDirection('validationNamedUsers', [], ['a']).direction).toBe('tighten')
      expect(policyWriteDirection('validationNamedUsers', ['a', 'b'], ['a']).direction).toBe('tighten')
    })
    it('[a] → [a, b] loosens (b may now validate); [a] → [] and [a] → null loosen (anyone)', () => {
      expect(policyWriteDirection('validationNamedUsers', ['a'], ['a', 'b']).direction).toBe('loosen')
      expect(policyWriteDirection('validationNamedUsers', ['a'], []).direction).toBe('loosen')
      expect(policyWriteDirection('validationNamedUsers', ['a'], null).direction).toBe('loosen')
    })
    it('[a] → [b] swaps a validator out — that admits someone new, so it loosens', () => {
      expect(policyWriteDirection('validationNamedUsers', ['a'], ['b']).direction).toBe('loosen')
    })
    it('same set in a different order is a no-op; a non-string[] is invalid', () => {
      expect(policyWriteDirection('validationNamedUsers', ['a', 'b'], ['b', 'a']).direction).toBe('tighten')
      expect(policyWriteDirection('validationNamedUsers', ['a'], 'a').direction).toBe('invalid')
      expect(policyWriteDirection('validationNamedUsers', ['a'], ['a', 1]).direction).toBe('invalid')
    })
  })
})

describe('loosensPolicy — batch filter', () => {
  it('returns only the loosening / invalid verdicts, ignoring non-policy keys', () => {
    const verdicts = loosensPolicy(
      [
        { key: 'systemPrompt', value: 'x' },
        { key: 'contributeToGlobalTm', value: false },
        { key: 'validationCount', value: 1 },
        { key: 'agentMemoryAutonomy', value: 'nonsense' },
      ],
      { validationCount: 3 },
    )
    expect(verdicts.map((v) => [v.key, v.direction])).toEqual([
      ['validationCount', 'loosen'],
      ['agentMemoryAutonomy', 'invalid'],
    ])
    expect(verdicts[0]).toMatchObject({ current: 3, proposed: 1 })
    expect(verdicts[0].reason).toBeTruthy()
  })

  it('a fresh project (no settings) accepts contributeToGlobalTm:false + agentAuthorship:"none"', () => {
    expect(
      loosensPolicy(
        [
          { key: 'contributeToGlobalTm', value: false },
          { key: 'agentAuthorship', value: 'none' },
        ],
        {},
      ),
    ).toEqual([])
  })
})
