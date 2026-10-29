// AI drafting settings (AQU-2259): the team's choices for how AI drafts are
// made, held in the shared project settings blob under `draftingSettings`.
//
// Before AQU-2259 every one of these lived only in the browser that set it
// (the device-local `completionSettings` on the IndexedDB project record), so
// a lead tuned drafting for their own browser while the page said the change
// applied to everyone. They are the team's settings, so they live here now,
// behind the same maintainer floor as the rest of the blob.
//
// WHAT IS DELIBERATELY NOT HERE: every AI key. The project completion key, the
// Gemini voice key, personal keys and organization keys keep their three
// levels exactly as before (project > personal > org, `resolveApiKey`). The
// blob is readable by every member, so a key in it would be a key handed to
// every member; the validator below refuses one by name. The written
// instructions are not here either: they are the top-level `systemPrompt`.
//
// Pure and dependency-free, with relative imports only, so both workers and
// the SPA can import it. The settings-key registry validates the key with
// `draftingSettingsProblem`; the identity worker's settings route refuses a
// changed malformed value with the same message; the SPA reads the stored
// value through `readDraftingSettings`, which drops anything malformed.

export const DRAFTING_SETTINGS_KEY = 'draftingSettings'

export type DraftingProvider = 'frontier' | 'custom'
export type DraftingContextSize = 'small' | 'medium' | 'large'
export type DraftingExampleFormat = 'source-and-target' | 'target-only'

/** The stored shape. Every field optional: an absent one is its default. */
export interface DraftingSettings {
  provider?: DraftingProvider
  endpoint?: string
  model?: string
  maxTokens?: number
  temperature?: number
  /** The Health penalty for AI drafts, 0–1. */
  llmHealthPenalty?: number
  top_k?: number
  contextSize?: DraftingContextSize
  useOnlyValidatedExamples?: boolean
  main_chat_language?: string
  fewShotExampleFormat?: DraftingExampleFormat
  completionBatchSize?: number
  validationBatchSize?: number
}

type FieldSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'string'; maxLength: number }
  | { kind: 'number'; min: number; max: number; integer: boolean }
  | { kind: 'boolean' }

/**
 * Every field the key may hold, with its type and range. The ranges are the
 * controls' own clamps where they have one, and generous where they do not,
 * so a value somebody already holds in their browser is not refused on its
 * way up.
 */
const FIELD_SPECS: Readonly<Record<keyof DraftingSettings, FieldSpec>> = {
  provider: { kind: 'enum', values: ['frontier', 'custom'] },
  endpoint: { kind: 'string', maxLength: 2048 },
  model: { kind: 'string', maxLength: 256 },
  maxTokens: { kind: 'number', min: 1, max: 1_000_000, integer: true },
  temperature: { kind: 'number', min: 0, max: 2, integer: false },
  llmHealthPenalty: { kind: 'number', min: 0, max: 1, integer: false },
  top_k: { kind: 'number', min: 1, max: 50, integer: true },
  contextSize: { kind: 'enum', values: ['small', 'medium', 'large'] },
  useOnlyValidatedExamples: { kind: 'boolean' },
  main_chat_language: { kind: 'string', maxLength: 100 },
  fewShotExampleFormat: { kind: 'enum', values: ['source-and-target', 'target-only'] },
  completionBatchSize: { kind: 'number', min: 1, max: 50, integer: true },
  validationBatchSize: { kind: 'number', min: 0, max: 500, integer: true },
}

export const DRAFTING_SETTINGS_FIELDS = Object.keys(FIELD_SPECS) as (keyof DraftingSettings)[]

/** Key-shaped fields that must never reach the shared blob. */
const KEY_FIELDS = new Set(['apiKey', 'geminiApiKey', 'key', 'token'])

export const DRAFTING_SETTINGS_TYPE_NAME =
  '{ provider?: "frontier" | "custom", endpoint?: string, model?: string, maxTokens?: integer, ' +
  'temperature?: 0–2, llmHealthPenalty?: 0–1, top_k?: 1–50, contextSize?: "small" | "medium" | "large", ' +
  'useOnlyValidatedExamples?: boolean, main_chat_language?: string, ' +
  'fewShotExampleFormat?: "source-and-target" | "target-only", completionBatchSize?: 1–50, ' +
  'validationBatchSize?: 0–500 } (no API keys)'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fieldProblem(name: string, spec: FieldSpec, value: unknown): string | null {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
        ? null
        : `${name} must be one of ${spec.values.map((v) => `"${v}"`).join(', ')}`
    case 'string':
      if (typeof value !== 'string') return `${name} must be a string`
      return value.length <= spec.maxLength ? null : `${name} is longer than ${spec.maxLength} characters`
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a number`
      if (spec.integer && !Number.isInteger(value)) return `${name} must be a whole number`
      return value >= spec.min && value <= spec.max ? null : `${name} must be between ${spec.min} and ${spec.max}`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} must be true or false`
  }
}

/** Null when `value` is a valid stored drafting-settings object, else what is wrong. */
export function draftingSettingsProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'draftingSettings must be an object'
  for (const [name, field] of Object.entries(value)) {
    if (KEY_FIELDS.has(name)) {
      return `draftingSettings must not hold "${name}": AI keys stay on the device, in Preferences or with the organization`
    }
    const spec = (FIELD_SPECS as Record<string, FieldSpec | undefined>)[name]
    if (!spec) return `draftingSettings has no field "${name}"`
    if (field === undefined) continue
    const problem = fieldProblem(name, spec, field)
    if (problem) return problem
  }
  return null
}

/**
 * The stored value as the SPA should use it: a field that is malformed, out of
 * range or unknown is dropped (it then reads as its default), and anything
 * that is not an object reads as "not set" (null). Never throws.
 */
export function readDraftingSettings(value: unknown): DraftingSettings | null {
  if (!isPlainObject(value)) return null
  const out: Record<string, unknown> = {}
  for (const name of DRAFTING_SETTINGS_FIELDS) {
    const field = value[name]
    if (field === undefined) continue
    if (fieldProblem(name, FIELD_SPECS[name], field) === null) out[name] = field
  }
  return out as DraftingSettings
}
