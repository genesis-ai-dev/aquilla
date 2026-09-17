// Regression test for the Wednesday input-validation pen-test pass: PatchSettings
// ops[].key must reject own-prototype-mutating keys, since both merge sites that
// consume it (db/shared/projects.ts::patchProjectSettingsShared and
// external/supersede.ts's comparison merge) do a raw `merged[op.key] = op.value`
// bracket assignment onto a plain object literal.

import { describe, it, expect } from 'vitest'
import { validatePatchSettingsCommand, type PatchValidationIssue } from '../external/commands-patch-settings'

function validate(ops: unknown) {
  const issues: PatchValidationIssue[] = []
  const cmd = validatePatchSettingsCommand(
    { projectId: 'proj-1', ifMatchVersion: 0, ops },
    0,
    issues,
  )
  return { cmd, issues }
}

describe('validatePatchSettingsCommand — reserved key guard', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('rejects ops[].key === %s', (key) => {
    const { cmd, issues } = validate([{ key, value: { polluted: true } }])
    expect(cmd).toBeNull()
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('reserved key')
  })

  it('still accepts an ordinary settings key', () => {
    const { cmd, issues } = validate([{ key: 'decaySettings', value: { halfLifeDays: 30 } }])
    expect(issues).toHaveLength(0)
    expect(cmd?.ops).toEqual([{ key: 'decaySettings', value: { halfLifeDays: 30 } }])
  })
})
