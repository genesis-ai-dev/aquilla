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
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Human-readable type name for a spec — used in errors and describe_command. */
export function settingsTypeName(spec: SettingsKeySpec): string {
  return spec.kind === 'enum' ? (spec.values ?? []).map((v) => `"${v}"`).join(' | ') : spec.kind
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
    case 'object':
      return isPlainObject(value)
    case 'object[]':
      return Array.isArray(value) && value.every(isPlainObject)
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

  // Validation policy (all POLICY keys — writable in the restrictive direction
  // only, see db/shared/policy-direction.ts; a loosening write resolves to
  // permission_denied rather than "unknown key")
  validationCount: { kind: 'number' },
  validationCountAudio: { kind: 'number' },
  validationRoleFloor: { kind: 'enum', values: ['reviewer', 'project_lead', 'maintainer'] },
  validationNamedUsers: { kind: 'string[]' },
  allowSelfValidation: { kind: 'boolean' },
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
  knowledgeBaseEnabled: { kind: 'boolean' },
  importExcludeFrontMatter: { kind: 'boolean' },

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
    return `settings key "${key}" expects ${settingsTypeName(spec)}`
  }
  return null
}

/** `key: type` lines for describe_command / docs, in registry order. */
export function settingsKeyDocLines(): string[] {
  return PROJECT_SETTINGS_KEYS.map(
    (key) => `${key}: ${settingsTypeName(PROJECT_SETTINGS_KEY_SPECS[key])}`,
  )
}
