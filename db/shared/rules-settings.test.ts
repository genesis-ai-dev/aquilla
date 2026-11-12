// AQU-2192: the settings validators for rules, rulePenalties, algorithmicChecks
// and algorithmicChecksByLane, through the same entry point PatchSettings and
// ProjectSetup use.

import { describe, expect, it } from 'vitest'
import { settingsKeyDocLines, validateSettingsKeyValue } from './project-settings-keys'

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: 'No double dash',
  description: 'Avoid --',
  severity: 'minor',
  source: 'user',
  scope: 'project',
  check: { type: 'target-forbids', targetPattern: '--' },
  enabled: true,
  createdAt: '2026-10-26T00:00:00.000Z',
  ...over,
})

type Case = [label: string, key: string, value: unknown, error: string | null]

const cases: Case[] = [
  // algorithmicChecks
  ['override off', 'algorithmicChecks', { 'usfm-structure': { enabled: false } }, null],
  ['override with severity, Bible id', 'algorithmicChecks', { 'bkp:V1': { enabled: true, severity: 'major' } }, null],
  ['empty map', 'algorithmicChecks', {}, null],
  ['clear', 'algorithmicChecks', null, null],
  ['unknown check id', 'algorithmicChecks', { 'usfm-strucure': { enabled: false } }, '"usfm-strucure"'],
  ['missing enabled', 'algorithmicChecks', { 'usfm-structure': { severity: 'minor' } }, 'algorithmicChecks["usfm-structure"].enabled'],
  ['bad severity', 'algorithmicChecks', { 'usfm-structure': { enabled: false, severity: 'high' } }, '.severity must be "major" or "minor"'],
  ['unknown field', 'algorithmicChecks', { 'usfm-structure': { enabled: false, note: 'x' } }, 'unknown field "note"'],
  ['bare boolean entry', 'algorithmicChecks', { 'usfm-structure': false }, 'algorithmicChecks["usfm-structure"] must be'],
  // algorithmicChecksByLane
  ['lane override', 'algorithmicChecksByLane', { '': { capitalization: { enabled: false } }, es: {} }, null],
  ['lane unknown check', 'algorithmicChecksByLane', { es: { nope: { enabled: false } } }, 'algorithmicChecksByLane["es"] names "nope"'],
  ['lane flat map', 'algorithmicChecksByLane', { es: { enabled: false } }, '"enabled", which is not a built-in check id'],
  ['lane not an object', 'algorithmicChecksByLane', { es: true }, 'algorithmicChecksByLane["es"] must be an object'],
  // rulePenalties
  ['penalties', 'rulePenalties', { major: 15, minor: 0 }, null],
  ['penalties missing minor', 'rulePenalties', { major: 15 }, 'rulePenalties.minor'],
  ['penalties negative', 'rulePenalties', { major: -1, minor: 5 }, 'rulePenalties.major must not be negative'],
  ['penalties string', 'rulePenalties', { major: '15', minor: 5 }, 'rulePenalties.major must be a finite number'],
  ['penalties extra', 'rulePenalties', { major: 1, minor: 1, critical: 9 }, 'unknown field "critical"'],
  // rules
  ['rules empty', 'rules', [], null],
  ['target-forbids', 'rules', [rule()], null],
  [
    'every optional field a writer persists',
    'rules',
    [
      rule({
        scope: 'lane',
        lane: 'es',
        source: 'llm',
        check: { type: 'source-requires-target', sourcePattern: 'God', targetPattern: 'Dios', caseSensitive: true },
        autofix: { kind: 'regex-replace', pattern: 'a', replacement: 'b', flags: 'gi' },
        autofixAttemptedAt: '2026-10-26T00:00:00.000Z',
        sourceProjectId: 'p9',
      }),
      rule({ id: 'r2', check: { type: 'source-target-match', pattern: '\\d+' } }),
    ],
    null,
  ],
  ['rules text-only legacy shape', 'rules', [{ text: 'x' }], 'rules[0] has an unknown field "text"'],
  ['rules missing field', 'rules', [rule(), (({ name: _n, ...rest }) => rest)(rule({ id: 'r2' }))], 'rules[1].name is required'],
  ['rules bad severity', 'rules', [rule({ severity: 'critical' })], 'rules[0].severity must be "major" | "minor"'],
  ['rules bad scope', 'rules', [rule({ scope: 'global' })], 'rules[0].scope'],
  ['rules lane without lane scope', 'rules', [rule({ lane: 'es' })], 'rules[0].lane only applies when scope is "lane"'],
  ['rules builtin type', 'rules', [rule({ check: { type: 'builtin', checkId: 'usfm-structure' } })], 'algorithmicChecks'],
  ['rules unknown check type', 'rules', [rule({ check: { type: 'regex' } })], 'rules[0].check.type must be'],
  ['rules check extra field', 'rules', [rule({ check: { type: 'target-forbids', targetPattern: 'x', pattern: 'y' } })], 'rules[0].check has an unknown field "pattern"'],
  ['rules bad regex', 'rules', [rule({ check: { type: 'target-forbids', targetPattern: '(' } })], 'rules[0].check.targetPattern is not a valid regular expression'],
  ['rules bad autofix', 'rules', [rule({ autofix: { kind: 'replace', pattern: 'a', replacement: 'b', flags: '' } })], 'rules[0].autofix.kind'],
  ['rules not an array', 'rules', { r1: rule() }, 'expects'],
  ['rules entry not an object', 'rules', ['x'], 'expects'],
]

describe('rules and checks settings validators', () => {
  it.each(cases)('%s', (_label, key, value, error) => {
    const got = validateSettingsKeyValue(key, value)
    if (error === null) expect(got).toBeNull()
    else expect(got).toContain(error)
  })

  it('shows the real shapes in describe_command instead of a bare object', () => {
    const lines = settingsKeyDocLines()
    for (const key of ['rules', 'rulePenalties', 'algorithmicChecks', 'algorithmicChecksByLane']) {
      const line = lines.find((l) => l.startsWith(`${key}:`))!
      expect(line).not.toMatch(/^[A-Za-z]+: object(\[\])?$/)
    }
    expect(lines.find((l) => l.startsWith('algorithmicChecks:'))).toContain('enabled: boolean')
  })
})
