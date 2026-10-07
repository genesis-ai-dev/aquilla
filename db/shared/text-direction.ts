// Shared text-direction vocabulary (AQU-1471).
//
// The language→direction table and the project-settings resolution rule live
// HERE, not in src/lib/text-direction.ts, because three surfaces have to agree
// about what direction a project's text runs in:
//
//   - the SPA editor, which renders `dir=` on every cell (src/lib/text-direction.ts
//     re-exports everything below so its callers are unchanged);
//   - sync-worker's Agent API, which reports the direction a staged import will
//     land in on the ProjectSetup receipt;
//   - the settings-key registry (project-settings-keys.ts), which has to agree
//     on the legal values.
//
// This file is METADATA + PURE FUNCTIONS ONLY and dependency-free, like every
// other db/shared module both workers and the SPA import.
//
// THE RESOLUTION ORDER IS THE WHOLE POINT, so it is stated once, here:
//
//   per-file row (files.meta.*TextDirection)  →  project setting  →  language
//
// A project-level setting is a DEFAULT, never a stamp: nothing copies it onto
// the file rows at import. Change `targetLanguage` from English to Arabic and
// every file that never had an explicit direction follows, which is the
// behaviour a 49-file project needs and a stamped copy could not give.

export type TextDirection = 'ltr' | 'rtl'
/** A direction, or "work it out from the text/language" — what a settings key
 *  and the per-file UI control both hold. */
export type DirectionMode = 'auto' | TextDirection

/** Legal values of the `sourceTextDirection` / `targetTextDirection` settings
 *  keys, in the order describe_command renders them. */
export const TEXT_DIRECTION_SETTING_VALUES: readonly DirectionMode[] = ['ltr', 'rtl', 'auto']

const RTL_LANGUAGE_CODES = new Set([
  'ar', 'ara', 'arb', 'arz',
  'arc', 'aii', 'syr', 'syc',
  'dv', 'div',
  'fa', 'fas', 'per', 'prs',
  'he', 'heb', 'iw',
  'khw',
  'ks', 'kas',
  'ku', 'kur', 'ckb',
  'nqo',
  'ps', 'pus', 'pbt',
  'sd', 'snd',
  'ug', 'uig',
  'ur', 'urd',
  'yi', 'yid',
])

const RTL_LANGUAGE_NAMES = new Set([
  'arabic',
  'aramaic',
  'assyrian',
  'dhivehi',
  'divehi',
  'farsi',
  'hebrew',
  'kashmiri',
  'kurdish',
  'nko',
  "n'ko",
  'pashto',
  'persian',
  'sindhi',
  'syriac',
  'urdu',
  'uyghur',
  'uighur',
  'yiddish',
])

export function normalizeLanguageToken(language: string | undefined | null): string {
  return (language ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
}

/** The direction a language runs in, by ISO code or by English name. Unknown
 *  (and absent) languages are 'ltr' — the overwhelming majority, and the
 *  pre-AQU-1471 behaviour. */
export function languageDefaultDirection(language: string | undefined | null): TextDirection {
  const normalized = normalizeLanguageToken(language)
  if (!normalized) return 'ltr'
  const code = normalized.split(/[-:\s]/)[0]
  if (RTL_LANGUAGE_CODES.has(code)) return 'rtl'
  if (RTL_LANGUAGE_NAMES.has(normalized)) return 'rtl'
  if (normalized.split(/\s+/).some((part) => RTL_LANGUAGE_NAMES.has(part))) return 'rtl'
  return 'ltr'
}

/** A stored/incoming direction value, or null when it is neither. */
export function normalizeTextDirection(value: unknown): TextDirection | null {
  return value === 'ltr' || value === 'rtl' ? value : null
}

/** A stored/incoming direction MODE (the settings-key shape), or null. */
export function normalizeDirectionMode(value: unknown): DirectionMode | null {
  return value === 'ltr' || value === 'rtl' || value === 'auto' ? value : null
}

/** The settings blob as the two resolvers below read it. Deliberately loose:
 *  sync-worker holds the blob as `Record<string, unknown>` and the SPA holds it
 *  as `ProjectWideSettings`, and both satisfy this. */
export interface TextDirectionSettings {
  sourceLanguage?: string | null
  targetLanguage?: string | null
  sourceTextDirection?: unknown
  targetTextDirection?: unknown
}

export type TextDirectionSide = 'source' | 'target'

/**
 * The project's EXPLICIT direction for one side, or null when it has none —
 * which includes the explicit `"auto"`, whose whole meaning is "fall through to
 * the language". Callers that already fall back to the language themselves
 * (the SPA's useFileMeta) want this one.
 */
export function projectSettingTextDirection(
  settings: TextDirectionSettings | null | undefined,
  side: TextDirectionSide,
): TextDirection | null {
  if (!settings) return null
  const raw = side === 'source' ? settings.sourceTextDirection : settings.targetTextDirection
  return normalizeTextDirection(raw)
}

/**
 * The direction one side of a project runs in, all the way down: the explicit
 * setting, else the language it is in, else 'ltr'. `languageOverride` names the
 * language of ONE file (a per-import `targetLanguage`), which takes precedence
 * over the project's when the setting is absent.
 */
export function resolveProjectTextDirection(
  settings: TextDirectionSettings | null | undefined,
  side: TextDirectionSide,
  languageOverride?: string | null,
): TextDirection {
  const explicit = projectSettingTextDirection(settings, side)
  if (explicit) return explicit
  const language = languageOverride
    ?? (side === 'source' ? settings?.sourceLanguage : settings?.targetLanguage)
  return languageDefaultDirection(language)
}
