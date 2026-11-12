// Validators for the Rules-page settings keys (AQU-2192): `rules`,
// `rulePenalties`, `algorithmicChecks` and `algorithmicChecksByLane`.
//
// Until now the key registry accepted any object for these, so an agent could
// store `rules: [{ text: "x" }]` and the renderer would ignore it without a
// word. Each validator here returns null when the value is fine, else a
// message naming the field (and array index) at fault.
//
// The shapes mirror `TranslationRule`, `RuleCheck`, `RuleAutofix`,
// `RulePenalties` and `AlgorithmicCheckOverride` in src/lib/parsers/types.ts.
// Pure and dependency-free (one relative import), so both workers can use it.

import { isBuiltinCheckKey, TEXT_CHECK_IDS } from './builtin-checks'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function unknownField(path: string, obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return `${path} has an unknown field "${key}" (allowed: ${allowed.join(', ')})`
  }
  return null
}

function quoted(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(' | ')
}

// ── algorithmicChecks ───────────────────────────────────────────────────────

export const ALGORITHMIC_CHECKS_TYPE_NAME =
  '{ [checkId]: { enabled: boolean, severity?: "major" | "minor" } } ' +
  '(checkId: a built-in check id such as "usfm-structure"; the list is below. An entry replaces that check\'s default; ' +
  'omit severity to keep the default severity)'

export const ALGORITHMIC_CHECKS_BY_LANE_TYPE_NAME =
  '{ [laneTag]: { [checkId]: { enabled: boolean, severity?: "major" | "minor" } } } ' +
  '(laneTag: the target lane\'s tag, "" for the default lane. A lane entry replaces the project-wide entry for that check)'

export const RULE_PENALTIES_TYPE_NAME = '{ major: number, minor: number } (points each finding costs; non-negative)'

const CHECK_OVERRIDE_FIELDS = ['enabled', 'severity'] as const

function overrideProblem(path: string, entry: unknown): string | null {
  if (!isPlainObject(entry)) return `${path} must be { enabled: boolean, severity?: "major" | "minor" }`
  const extra = unknownField(path, entry, CHECK_OVERRIDE_FIELDS)
  if (extra) return extra
  if (typeof entry.enabled !== 'boolean') return `${path}.enabled must be true or false`
  if (entry.severity !== undefined && entry.severity !== 'major' && entry.severity !== 'minor') {
    return `${path}.severity must be "major" or "minor" (omit it for the default)`
  }
  return null
}

function checkOverridesProblem(path: string, value: Record<string, unknown>): string | null {
  for (const [id, entry] of Object.entries(value)) {
    if (!isBuiltinCheckKey(id)) {
      return (
        `${path} names "${id}", which is not a built-in check id ` +
        `(text checks: ${TEXT_CHECK_IDS.join(', ')}; Bible data checks are "bkp:..." ids)`
      )
    }
    const problem = overrideProblem(`${path}["${id}"]`, entry)
    if (problem) return problem
  }
  return null
}

export function algorithmicChecksProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'must be an object keyed by check id'
  return checkOverridesProblem('algorithmicChecks', value)
}

export function algorithmicChecksByLaneProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'must be an object keyed by lane tag'
  for (const [lane, entries] of Object.entries(value)) {
    const path = `algorithmicChecksByLane["${lane}"]`
    if (!isPlainObject(entries)) return `${path} must be an object keyed by check id`
    const problem = checkOverridesProblem(path, entries)
    if (problem) return problem
  }
  return null
}

// ── rulePenalties ───────────────────────────────────────────────────────────

export function rulePenaltiesProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'must be { major: number, minor: number }'
  const extra = unknownField('rulePenalties', value, ['major', 'minor'])
  if (extra) return extra
  for (const key of ['major', 'minor'] as const) {
    const n = value[key]
    if (typeof n !== 'number' || !Number.isFinite(n)) return `rulePenalties.${key} must be a finite number`
    if (n < 0) return `rulePenalties.${key} must not be negative`
  }
  return null
}

// ── rules ───────────────────────────────────────────────────────────────────

export const RULE_FIELDS = [
  'id',
  'name',
  'description',
  'severity',
  'source',
  'scope',
  'lane',
  'check',
  'enabled',
  'createdAt',
  'autofix',
  'autofixAttemptedAt',
  'sourceProjectId',
] as const

const RULE_SOURCES = ['algorithmic', 'llm', 'user'] as const
const RULE_SCOPES = ['project', 'org', 'lane'] as const
const SEVERITIES = ['major', 'minor'] as const

export const RULES_TYPE_NAME =
  '{ id: string, name: string, description: string, severity: "major" | "minor", ' +
  'source: "algorithmic" | "llm" | "user", scope: "project" | "org" | "lane", lane?: string (with scope "lane"), ' +
  'check: RuleCheck, enabled: boolean, createdAt: string (ISO), autofix?: { kind: "regex-replace", pattern: string, ' +
  'replacement: string, flags: string }, autofixAttemptedAt?: string, sourceProjectId?: string }[] ' +
  'where RuleCheck is { type: "source-requires-target", sourcePattern: string, targetPattern: string, caseSensitive?: boolean } | ' +
  '{ type: "target-forbids", targetPattern: string, caseSensitive?: boolean } | ' +
  '{ type: "source-target-match", pattern: string } (patterns are regular expressions). ' +
  'These are your own rules only: built-in checks are switched with algorithmicChecks, never listed here'

function regexProblem(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u')
    return false
  } catch {
    try {
      new RegExp(pattern)
      return false
    } catch {
      return true
    }
  }
}

function patternProblem(path: string, v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return `${path} must be a non-empty regular expression string`
  if (regexProblem(v)) return `${path} is not a valid regular expression`
  return null
}

function ruleCheckProblem(path: string, check: unknown): string | null {
  if (!isPlainObject(check)) return `${path} must be an object with a "type"`
  switch (check.type) {
    case 'source-requires-target': {
      const extra = unknownField(path, check, ['type', 'sourcePattern', 'targetPattern', 'caseSensitive'])
      if (extra) return extra
      return (
        patternProblem(`${path}.sourcePattern`, check.sourcePattern) ??
        patternProblem(`${path}.targetPattern`, check.targetPattern) ??
        caseFlagProblem(path, check)
      )
    }
    case 'target-forbids': {
      const extra = unknownField(path, check, ['type', 'targetPattern', 'caseSensitive'])
      if (extra) return extra
      return patternProblem(`${path}.targetPattern`, check.targetPattern) ?? caseFlagProblem(path, check)
    }
    case 'source-target-match': {
      const extra = unknownField(path, check, ['type', 'pattern'])
      if (extra) return extra
      return patternProblem(`${path}.pattern`, check.pattern)
    }
    case 'builtin':
      return (
        `${path}.type "builtin" is not stored: built-in checks are switched on or off with the ` +
        '"algorithmicChecks" key (for example { "usfm-structure": { "enabled": false } })'
      )
    default:
      return `${path}.type must be ${quoted(['source-requires-target', 'target-forbids', 'source-target-match'])}`
  }
}

function caseFlagProblem(path: string, check: Record<string, unknown>): string | null {
  return check.caseSensitive === undefined || typeof check.caseSensitive === 'boolean'
    ? null
    : `${path}.caseSensitive must be true or false`
}

function autofixProblem(path: string, fix: unknown): string | null {
  if (!isPlainObject(fix)) return `${path} must be { kind: "regex-replace", pattern, replacement, flags }`
  const extra = unknownField(path, fix, ['kind', 'pattern', 'replacement', 'flags', 'rationale'])
  if (extra) return extra
  if (fix.kind !== 'regex-replace') return `${path}.kind must be "regex-replace"`
  if (typeof fix.pattern !== 'string' || fix.pattern === '') return `${path}.pattern must be a non-empty string`
  if (typeof fix.replacement !== 'string') return `${path}.replacement must be a string`
  if (typeof fix.flags !== 'string') return `${path}.flags must be a string (may be empty)`
  try {
    new RegExp(fix.pattern, fix.flags)
  } catch {
    return `${path} has a pattern or flags that is not a valid regular expression`
  }
  if (fix.rationale !== undefined && typeof fix.rationale !== 'string') return `${path}.rationale must be a string`
  return null
}

function ruleProblem(index: number, rule: unknown): string | null {
  const path = `rules[${index}]`
  if (!isPlainObject(rule)) return `${path} must be an object`
  const extra = unknownField(path, rule, RULE_FIELDS)
  if (extra) return extra
  for (const key of ['id', 'name', 'description', 'createdAt'] as const) {
    if (typeof rule[key] !== 'string') return `${path}.${key} is required and must be a string`
  }
  if (rule.id === '') return `${path}.id must not be empty`
  if (!(SEVERITIES as readonly unknown[]).includes(rule.severity)) {
    return `${path}.severity must be ${quoted(SEVERITIES)}`
  }
  if (!(RULE_SOURCES as readonly unknown[]).includes(rule.source)) {
    return `${path}.source must be ${quoted(RULE_SOURCES)}`
  }
  if (!(RULE_SCOPES as readonly unknown[]).includes(rule.scope)) {
    return `${path}.scope must be ${quoted(RULE_SCOPES)}`
  }
  if (typeof rule.enabled !== 'boolean') return `${path}.enabled is required and must be true or false`
  if (rule.lane !== undefined) {
    if (typeof rule.lane !== 'string') return `${path}.lane must be a string`
    if (rule.scope !== 'lane') return `${path}.lane only applies when scope is "lane"`
  }
  if (rule.autofixAttemptedAt !== undefined && typeof rule.autofixAttemptedAt !== 'string') {
    return `${path}.autofixAttemptedAt must be a string`
  }
  if (rule.sourceProjectId !== undefined && typeof rule.sourceProjectId !== 'string') {
    return `${path}.sourceProjectId must be a string`
  }
  if (rule.check === undefined) return `${path}.check is required`
  const checkProblem = ruleCheckProblem(`${path}.check`, rule.check)
  if (checkProblem) return checkProblem
  if (rule.autofix !== undefined) return autofixProblem(`${path}.autofix`, rule.autofix)
  return null
}

export function rulesProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'must be an array of rule objects'
  for (let i = 0; i < value.length; i++) {
    const problem = ruleProblem(i, value[i])
    if (problem) return problem
  }
  return null
}
