// Project-settings key registry (AQU-1224) — the authoritative list of
// top-level `project_settings.settings` keys an agent may write, with the type
// each one holds.
//
// This file is METADATA + PURE VALIDATORS ONLY, dependency-free so BOTH
// workers can import it: sync-worker rejects unknown/mistyped keys at
// PatchSettings prepare, and the command catalog renders the same list into
// `describe_command("PatchSettings")` so an agent discovers the legal keys
// instead of guessing at them.
//
// It mirrors `ProjectWideSettings` in src/lib/sync/project-settings.ts — the
// SPA's view of the same blob — plus two keys that live only server-side:
// the `healthSettings`/`decaySettings` alias pair normalizeSettings() keeps in
// step (db/shared/projects.ts) and the policy keys that are agent-writable
// only in their restrictive direction (AQU-1282, db/shared/policy-direction.ts)
// but must still be RECOGNISED here, so a loosening write earns the
// `permission_denied` it deserves rather than being mistaken for a typo.
//
// Adding a settings key? Add it here too, or agents cannot write it.

import { TEXT_DIRECTION_SETTING_VALUES } from './text-direction'
import { BIBLE_ENRICHMENT_IDS } from './bible-enrichments'
import { LANGUAGE_PROFILE_TYPE_NAME, languageProfileProblem } from './language-profile'
import { PROJECT_FACTS_TYPE_NAME, projectFactsProblem } from './project-facts'

/** How a key's value is described to callers (validation errors + docs). */
export type SettingsValueKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'object'
  | 'object[]'
  | 'enum'

export interface SettingsKeySpec {
  kind: SettingsValueKind
  /** Allowed values when `kind` is 'enum'. */
  values?: readonly string[]
  /**
   * AQU-1686: when `kind` is 'object', the only keys the object may hold, and
   * each must hold a boolean. Absent means any plain object.
   */
  booleanFlags?: readonly string[]
  /**
   * AQU-1688: when `kind` is 'object' (or, since AQU-1691, 'object[]'), a
   * structural check the value must also pass. Returns null when it is fine,
   * else what is wrong.
   */
  problem?: (value: unknown) => string | null
  /** AQU-1688: the type shown in errors and describe_command, when `kind` undersells it. */
  typeName?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Human-readable type name for a spec — used in errors and describe_command. */
export function settingsTypeName(spec: SettingsKeySpec): string {
  if (spec.typeName) return spec.typeName
  if (spec.kind === 'enum') return (spec.values ?? []).map((v) => `"${v}"`).join(' | ')
  if (spec.kind === 'object' && spec.booleanFlags) {
    return `{ ${spec.booleanFlags.map((flag) => `"${flag}"?: boolean`).join(', ')} }`
  }
  return spec.kind
}

function matchesSpec(spec: SettingsKeySpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
    case 'object': {
      if (!isPlainObject(value)) return false
      if (spec.problem && spec.problem(value) !== null) return false
      const flags = spec.booleanFlags
      if (!flags) return true
      return Object.entries(value).every(
        ([key, flag]) => flags.includes(key) && typeof flag === 'boolean',
      )
    }
    case 'object[]':
      return Array.isArray(value) && value.every(isPlainObject) && (!spec.problem || spec.problem(value) === null)
    case 'enum':
      return typeof value === 'string' && (spec.values ?? []).includes(value)
  }
}

/**
 * Every writable top-level settings key, in the order describe_command lists
 * them (roughly: identity → drafting → validation policy → capability
 * switches → structured blobs).
 */
export const PROJECT_SETTINGS_KEY_SPECS: Readonly<Record<string, SettingsKeySpec>> = {
  // Identity / language
  sourceLanguage: { kind: 'string' },
  targetLanguage: { kind: 'string' },
  targetLanes: { kind: 'string[]' },
  archivedLanes: { kind: 'string[]' },
  // AQU-1471: the project's DEFAULT text direction per side. "auto" (and an
  // absent key) means "take it from the language", which is what every project
  // did before these keys existed. They are a default, never a stamp: nothing
  // copies them onto the file rows, so a per-file override still wins and
  // changing targetLanguage still moves every file that has no override.
  sourceTextDirection: { kind: 'enum', values: TEXT_DIRECTION_SETTING_VALUES },
  targetTextDirection: { kind: 'enum', values: TEXT_DIRECTION_SETTING_VALUES },

  // Drafting
  systemPrompt: { kind: 'string' },
  draftContext: { kind: 'object' },
  translationBrief: { kind: 'object' },
  livingMemoryEntries: { kind: 'object[]' },
  alignmentSeeds: { kind: 'object[]' },

  // Rules / checks
  rules: { kind: 'object[]' },
  rulePenalties: { kind: 'object' },
  algorithmicChecks: { kind: 'object' },
  terminology: { kind: 'object[]' },
  // AQU-1688: facts about the target language that Bible data checks need
  // (db/shared/language-profile.ts). A check whose slot is empty is dormant.
  languageProfile: {
    kind: 'object',
    problem: (value) => languageProfileProblem(value),
    typeName: LANGUAGE_PROFILE_TYPE_NAME,
  },
  // AQU-1691: the decision log — answers to one-off questions that later
  // drafts must honour (db/shared/project-facts.ts). One entry per key; a key
  // that names a Language-profile slot belongs in languageProfile instead.
  projectFacts: {
    kind: 'object[]',
    problem: (value) => projectFactsProblem(value),
    typeName: PROJECT_FACTS_TYPE_NAME,
  },

  // Validation policy (all POLICY keys — writable in the restrictive direction
  // only, see db/shared/policy-direction.ts; a loosening write resolves to
  // permission_denied rather than "unknown key")
  validationCount: { kind: 'number' },
  validationCountAudio: { kind: 'number' },
  validationRoleFloor: { kind: 'enum', values: ['reviewer', 'project_lead', 'maintainer'] },
  validationNamedUsers: { kind: 'string[]' },
  allowSelfValidation: { kind: 'boolean' },
  // AQU-490: the audio twins. Separate keys rather than shared ones, by Sam's
  // ruling — a project can reasonably want two ears on a recording and one on
  // a translation, or trust a different set of people with each. A project
  // that sets none of them gets the text defaults' behaviour, not the text
  // project's settings: absent means unrestricted here exactly as it does
  // above, and the two are never read as fallbacks for each other.
  validationRoleFloorAudio: { kind: 'enum', values: ['reviewer', 'project_lead', 'maintainer'] },
  validationNamedUsersAudio: { kind: 'string[]' },
  allowSelfValidationAudio: { kind: 'boolean' },
  // AQU-490: ACCEPTED AND IGNORED. This was briefly a real switch — whether
  // the audio validation control appeared in the TEXT view's gutter — and Sam
  // dropped it a day later: the control simply appears wherever a line has a
  // recording, on every project. Nothing reads the key any more. It stays
  // listed for the reason `agentAuthorship` below does: a client or an agent
  // that still names it should get a clean answer rather than "unknown key",
  // and any project stamped by an early 0096 still carries it in its blob.
  showAudioValidationInTextView: { kind: 'boolean' },
  harmonize_min_role: { kind: 'enum', values: ['project_lead', 'maintainer'] },
  agentMemoryAutonomy: { kind: 'enum', values: ['human', 'agent-low-risk'] },
  contributeToGlobalTm: { kind: 'boolean' },
  // AQU-1180: drops author fields from agent-facing reads. Recognised so an
  // agent naming it gets permission_denied rather than "unknown key".
  agentAuthorship: { kind: 'enum', values: ['none'] },
  // AQU-1068: who may add/remove cells; "none" = nobody (the default). Ordered
  // loosest → tightest in db/shared/policy-direction.ts.
  cellEditingFloor: {
    kind: 'enum',
    values: ['none', 'commenter', 'reviewer', 'contributor', 'project_lead', 'maintainer'],
  },

  // Capability switches
  allowLineCreation: { kind: 'boolean' },
  allowTrackEditing: { kind: 'boolean' },
  timingLocked: { kind: 'boolean' },
  audioTimingMode: { kind: 'enum', values: ['dubbing', 'audioFirst'] },
  bibleResourcesEnabled: { kind: 'boolean' },
  // AQU-1686: one switch per Bible data enrichment (db/shared/bible-enrichments.ts).
  // A missing id means that enrichment's default.
  bibleEnrichments: { kind: 'object', booleanFlags: BIBLE_ENRICHMENT_IDS },
  knowledgeBaseEnabled: { kind: 'boolean' },
  importExcludeFrontMatter: { kind: 'boolean' },
  smartQuotes: { kind: 'boolean' },

  // Structured blobs
  ttsSettings: { kind: 'object' },
  dcsUpstream: { kind: 'object' },
  decaySettings: { kind: 'object' },
  /** Read alias of decaySettings, kept in step by normalizeSettings(). */
  healthSettings: { kind: 'object' },
}

export const PROJECT_SETTINGS_KEYS: readonly string[] = Object.keys(PROJECT_SETTINGS_KEY_SPECS)

export function isKnownSettingsKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROJECT_SETTINGS_KEY_SPECS, key)
}

/**
 * Validate one `{key, value}` settings op against the registry.
 *
 * Returns null when it is fine, else a message naming what is wrong — the
 * unknown key, or the type the key actually expects. `null` is accepted for
 * every key: JSON cannot carry `undefined`, so storing null is the only way a
 * caller can clear a key (see PatchSettingsOp).
 */
export function validateSettingsKeyValue(key: string, value: unknown): string | null {
  const spec = PROJECT_SETTINGS_KEY_SPECS[key]
  if (!spec) {
    return `unknown settings key "${key}" — call describe_command("PatchSettings") for the valid keys`
  }
  if (value === null) return null
  if (!matchesSpec(spec, value)) {
    // A structural problem names the field at fault, not only the expected type.
    const detail = spec.problem && (isPlainObject(value) || Array.isArray(value)) ? spec.problem(value) : null
    return `settings key "${key}" expects ${settingsTypeName(spec)}${detail ? ` (${detail})` : ''}`
  }
  return null
}

/** `key: type` lines for describe_command / docs, in registry order. */
export function settingsKeyDocLines(): string[] {
  return PROJECT_SETTINGS_KEYS.map(
    (key) => `${key}: ${settingsTypeName(PROJECT_SETTINGS_KEY_SPECS[key])}`,
  )
}
