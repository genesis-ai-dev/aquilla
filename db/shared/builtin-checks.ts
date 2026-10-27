// Built-in check metadata (AQU-2192): the one place that says which checks
// exist, what they are called and whether they start on.
//
// The SPA's Rules page (src/lib/lqa/builtin-registry.ts, which adds each text
// check's `run` function and description) and the Agent API's settings read
// (sync-worker/src/external/read-routes.ts) both resolve a project's checks
// from this table, so the two can never disagree about a default.
//
// Dependency-free apart from the Bible check id list, so both workers can
// import it. The `name` strings are the English default-locale copy; the SPA
// translates them through its i18n catalog.

import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  BIBLE_CHECK_IDS,
  type BibleCheckId,
} from './bible-checks/types'

export type CheckSeverity = 'major' | 'minor'

export const TEXT_CHECK_IDS = [
  'empty-target',
  'target-equals-source',
  'placeholder-integrity',
  'number-integrity',
  'number-integrity-extra',
  'end-punctuation-mismatch',
  'punctuation-integrity',
  'double-space',
  'repeated-word',
  'unpaired-symbols',
  'abbreviation-mismatch',
  'usfm-structure',
  'capitalization',
  'footnote-quote-mismatch',
  'corrupted-characters',
  'unpaired-quotes',
  'untranslated-fragment',
  'length-ratio',
] as const
export type TextCheckId = (typeof TEXT_CHECK_IDS)[number]

export type BuiltinCheckKey = TextCheckId | BibleCheckId

export interface BuiltinCheckMeta {
  id: BuiltinCheckKey
  /** English name, as the Rules page shows it. */
  name: string
  defaultSeverity: CheckSeverity
  defaultEnabled: boolean
}

/** One override entry, as `algorithmicChecks` stores it. */
export interface CheckOverride {
  enabled: boolean
  /** Omit to use the default severity. */
  severity?: CheckSeverity
}

type TextCheckMeta = BuiltinCheckMeta & { id: TextCheckId }

export const TEXT_CHECK_META: Readonly<Record<TextCheckId, TextCheckMeta>> = {
  "empty-target": { id: "empty-target", name: "Empty translation", defaultSeverity: "major", defaultEnabled: true },
  "target-equals-source": { id: "target-equals-source", name: "Identical to source", defaultSeverity: "major", defaultEnabled: true },
  "placeholder-integrity": { id: "placeholder-integrity", name: "Placeholder integrity", defaultSeverity: "major", defaultEnabled: true },
  "number-integrity": { id: "number-integrity", name: "Number integrity", defaultSeverity: "major", defaultEnabled: true },
  "number-integrity-extra": { id: "number-integrity-extra", name: "Extra numbers", defaultSeverity: "minor", defaultEnabled: true },
  "end-punctuation-mismatch": { id: "end-punctuation-mismatch", name: "End punctuation", defaultSeverity: "minor", defaultEnabled: true },
  "punctuation-integrity": { id: "punctuation-integrity", name: "Punctuation integrity", defaultSeverity: "minor", defaultEnabled: true },
  "double-space": { id: "double-space", name: "Extra whitespace", defaultSeverity: "minor", defaultEnabled: true },
  "repeated-word": { id: "repeated-word", name: "Repeated word", defaultSeverity: "minor", defaultEnabled: true },
  "unpaired-symbols": { id: "unpaired-symbols", name: "Unpaired brackets", defaultSeverity: "minor", defaultEnabled: true },
  "abbreviation-mismatch": { id: "abbreviation-mismatch", name: "Abbreviation pass-through", defaultSeverity: "minor", defaultEnabled: false },
  "usfm-structure": { id: "usfm-structure", name: "USFM markers", defaultSeverity: "major", defaultEnabled: true },
  "capitalization": { id: "capitalization", name: "Capitalization", defaultSeverity: "minor", defaultEnabled: true },
  "footnote-quote-mismatch": { id: "footnote-quote-mismatch", name: "Footnote quote", defaultSeverity: "minor", defaultEnabled: true },
  "corrupted-characters": { id: "corrupted-characters", name: "Corrupted characters", defaultSeverity: "major", defaultEnabled: true },
  "unpaired-quotes": { id: "unpaired-quotes", name: "Unpaired quotes", defaultSeverity: "minor", defaultEnabled: true },
  "untranslated-fragment": { id: "untranslated-fragment", name: "Untranslated words", defaultSeverity: "minor", defaultEnabled: true },
  "length-ratio": { id: "length-ratio", name: "Length mismatch", defaultSeverity: "minor", defaultEnabled: false },
}

/** English names of the Bible data checks. Severity comes from db/shared/bible-checks/types.ts. */
export const BIBLE_CHECK_NAMES: Readonly<Record<BibleCheckId, string>> = {
  "bkp:V1": "Quotation opens",
  "bkp:V2": "Quotation closes",
  "bkp:V3": "Quotation continues",
  "bkp:V5": "Nested quotation marks",
  "bkp:V7": "Quotation marks without speech",
  "bkp:V8": "Interrupted quotation",
  "bkp:V9": "Speaker's own framing",
  "bkp:M1": "Question kept",
  "bkp:N1": "Number kept",
  "bkp:N2": "Ordinal number kept",
  "bkp:M3": "Negation kept",
  "bkp:S1": "Heading for each passage",
  "bkp:S3": "Sentence runs on",
  "bkp:S6": "Verses the oldest manuscripts lack",
  "bkp:S7": "Disputed passages",
  "bkp:S8": "Verse numbering",
  "bkp:P1": "Names kept",
  "bkp:P2": "One name across the file",
  "bkp:P3": "Namesakes told apart",
  "bkp:P4": "Name form kept",
  "bkp:P5": "No names the source lacks",
  "bkp:P6": "Implied subject named correctly",
  "bkp:P8": "Singular or plural “you”",
  "bkp:P9": "Inclusive or exclusive “we”",
  "bkp:P10": "Dual, trial and paucal forms",
  "bkp:P14": "Lord and Spirit",
  "bkp:P15": "Capitals for God",
  "bkp:X3": "Repeated quotations alike",
  "bkp:X4": "Decisions kept",
}

export const BIBLE_CHECK_META: Readonly<Record<BibleCheckId, BuiltinCheckMeta>> = Object.fromEntries(
  BIBLE_CHECK_IDS.map((id): [BibleCheckId, BuiltinCheckMeta] => [
    id,
    {
      id,
      name: BIBLE_CHECK_NAMES[id],
      // Design-doc W and I map onto the project's major and minor.
      defaultSeverity: BIBLE_CHECK_DEFAULT_SEVERITY[id] === 'warning' ? 'major' : 'minor',
      defaultEnabled: true,
    },
  ]),
) as Record<BibleCheckId, BuiltinCheckMeta>

export function isTextCheckId(value: string): value is TextCheckId {
  return Object.prototype.hasOwnProperty.call(TEXT_CHECK_META, value)
}

export function isBibleCheckKey(value: string): value is BibleCheckId {
  return Object.prototype.hasOwnProperty.call(BIBLE_CHECK_META, value)
}

/** Any id `algorithmicChecks` may name: a text check or a Bible data check. */
export function isBuiltinCheckKey(value: string): value is BuiltinCheckKey {
  return isTextCheckId(value) || isBibleCheckKey(value)
}

export function builtinCheckMeta(id: BuiltinCheckKey): BuiltinCheckMeta {
  return isTextCheckId(id) ? TEXT_CHECK_META[id] : BIBLE_CHECK_META[id as BibleCheckId]
}

/** One row of the effective check list an agent reads. */
export interface EffectiveCheck {
  id: BuiltinCheckKey
  name: string
  enabled: boolean
  severity: CheckSeverity
  /** True when the project (or lane) has an entry for this check. */
  overridden: boolean
}

export type CheckOverrideMap = Partial<Record<string, CheckOverride>>

function readOverride(raw: unknown): CheckOverride | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  const severity = entry.severity === 'major' || entry.severity === 'minor' ? entry.severity : undefined
  const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : undefined
  if (enabled === undefined && severity === undefined) return undefined
  return { enabled: enabled as boolean, ...(severity ? { severity } : {}) }
}

/**
 * The checks in force given an override map: every default, with each
 * override laid over its check. Mirrors `resolveBuiltinRules` in the SPA
 * (an entry with no `enabled` keeps the default switch). Bible data checks
 * are listed only when `bibleChecks` is true.
 */
export function effectiveChecks(
  overrides: unknown,
  options: { bibleChecks?: boolean } = {},
): EffectiveCheck[] {
  const map = typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)
    ? (overrides as Record<string, unknown>)
    : {}
  const ids: readonly BuiltinCheckKey[] = options.bibleChecks
    ? [...TEXT_CHECK_IDS, ...BIBLE_CHECK_IDS]
    : TEXT_CHECK_IDS
  return ids.map((id) => {
    const meta = builtinCheckMeta(id)
    const ov = Object.prototype.hasOwnProperty.call(map, id) ? readOverride(map[id]) : undefined
    return {
      id,
      name: meta.name,
      enabled: typeof ov?.enabled === 'boolean' ? ov.enabled : meta.defaultEnabled,
      severity: ov?.severity ?? meta.defaultSeverity,
      overridden: ov !== undefined,
    }
  })
}

/**
 * The override map in force in one lane: the lane's entries laid over the
 * project's, per check id (a lane entry REPLACES the project entry for that
 * check). Same rule as `laneCheckOverrides` in the SPA.
 */
export function mergeLaneOverrides(projectWide: unknown, laneEntries: unknown): Record<string, unknown> {
  const base = typeof projectWide === 'object' && projectWide !== null && !Array.isArray(projectWide)
    ? (projectWide as Record<string, unknown>)
    : {}
  const lane = typeof laneEntries === 'object' && laneEntries !== null && !Array.isArray(laneEntries)
    ? (laneEntries as Record<string, unknown>)
    : {}
  return { ...base, ...lane }
}
