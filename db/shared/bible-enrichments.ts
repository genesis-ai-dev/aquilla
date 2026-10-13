// Bible data enrichments (AQU-1686): the static inventory behind the "Bible
// data" card in Settings → General, and the `bibleEnrichments` project setting.
//
// Pure and dependency-free, with relative imports only and no DOM or i18n, so
// both workers can import it. The settings-key registry validates
// `bibleEnrichments` against these ids, and the auth-worker resolves a
// project's effective flags with `resolveBibleEnrichments`
// (auth-worker/src/lib/aquifer/gate.ts). The label and description keys live
// in the SPA (src/lib/bible-data/enrichment-labels.ts), because `MessageKey`
// is SPA-side.
//
// Spec: aquilla-specs 04-features/bible-knowledge-layer.md and the story
// choose-bible-data-enrichments.

/** Bible Knowledge Pack layers. The pack has one file per book for each layer. */
export const BKP_LAYERS = ['text', 'structure', 'voices', 'people', 'notes', 'terms'] as const
export type BkpLayer = (typeof BKP_LAYERS)[number]

export type BibleDataLicense = 'CC BY 4.0' | 'CC BY-SA 4.0'

export const BIBLE_DATA_LICENSE_URLS: Readonly<Record<BibleDataLicense, string>> = {
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
}

/** The open datasets the pack is built from. The Data sources dialog lists each one. */
export const BIBLE_DATA_SOURCE_IDS = [
  'macula',
  'opentext',
  'speaker-quotations',
  'acai',
  'unfoldingword',
] as const
export type BibleDataSourceId = (typeof BIBLE_DATA_SOURCE_IDS)[number]

export const BIBLE_DATA_SOURCE_LICENSES: Readonly<Record<BibleDataSourceId, BibleDataLicense>> = {
  // Macula Greek and Hebrew (Clear-Bible).
  macula: 'CC BY 4.0',
  // OpenText context-annotation.
  opentext: 'CC BY-SA 4.0',
  // Clear speaker-quotations.
  'speaker-quotations': 'CC BY 4.0',
  // ACAI (BibleAquifer).
  acai: 'CC BY-SA 4.0',
  // unfoldingWord Translation Notes, Questions and Words.
  unfoldingword: 'CC BY-SA 4.0',
}

export const BIBLE_ENRICHMENT_IDS = [
  'voices',
  'whos-who',
  'structure',
  'original-context',
  'helps',
  'terms',
  'places',
  'checks',
  'autopilot',
] as const
export type BibleEnrichmentId = (typeof BIBLE_ENRICHMENT_IDS)[number]

export interface BibleEnrichmentSpec {
  /** The pack layers it needs. When it is off, nothing loads them for it. */
  layers: readonly BkpLayer[]
  /** The value when the project has made no explicit choice. */
  default: boolean
  /** The license its data carries. It is never less strict than one of its sources. */
  license: BibleDataLicense
  /** The datasets its data comes from. */
  sources: readonly BibleDataSourceId[]
}

export const BIBLE_ENRICHMENTS: Readonly<Record<BibleEnrichmentId, BibleEnrichmentSpec>> = {
  voices: {
    layers: ['voices', 'people'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['opentext', 'speaker-quotations', 'macula', 'acai'],
  },
  // AQU-1689: the cast is per pericope, and pericopes are the structure
  // layer's segments (OpenText), so Who's Who loads that layer too.
  'whos-who': {
    layers: ['people', 'text', 'structure'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['acai', 'macula', 'opentext'],
  },
  structure: {
    layers: ['structure'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['opentext', 'macula'],
  },
  'original-context': {
    layers: ['text', 'people'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['macula', 'acai'],
  },
  helps: {
    layers: ['notes'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['unfoldingword'],
  },
  terms: {
    layers: ['terms'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['unfoldingword', 'acai'],
  },
  places: {
    layers: ['people'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['acai'],
  },
  // The family switch only. Each check is configured in Rules → Built-in checks.
  checks: {
    layers: ['text', 'structure', 'voices', 'people'],
    default: true,
    license: 'CC BY-SA 4.0',
    sources: ['macula', 'opentext', 'speaker-quotations', 'acai'],
  },
  // Off until autopilot's use of Bible data has been evaluated in shadow mode.
  autopilot: {
    layers: ['text', 'structure', 'voices', 'people'],
    default: false,
    license: 'CC BY-SA 4.0',
    sources: ['macula', 'opentext', 'speaker-quotations', 'acai'],
  },
}

/** The stored shape of `bibleEnrichments`: explicit choices only. A missing id means its default. */
export type BibleEnrichmentSettings = Partial<Record<BibleEnrichmentId, boolean>>

export function isBibleEnrichmentId(value: string): value is BibleEnrichmentId {
  return (BIBLE_ENRICHMENT_IDS as readonly string[]).includes(value)
}

/** The settings a resolver reads. A ProjectRecord and a settings blob both fit. */
export interface BibleDataSettings {
  /** The explicit Bible data switch. Absent or null means "derive from scripture files". */
  bibleResourcesEnabled?: boolean | null
  bibleEnrichments?: BibleEnrichmentSettings | null
}

/**
 * The effective value of one enrichment:
 *
 *   Bible data switch off → false, whatever the enrichment says
 *   explicit boolean      → that value
 *   nothing set           → the registry default
 *
 * The switch derives as `resolveBibleResourcesEnabled` does
 * (src/lib/parsers/types.ts) and the aquifer gate does on the server: an
 * explicit value wins, otherwise the project's scripture files decide. A
 * stored value that is not a boolean counts as unset.
 */
export function resolveBibleEnrichment(
  settings: BibleDataSettings,
  id: BibleEnrichmentId,
  hasScriptureFiles: boolean,
): boolean {
  const explicitSwitch = settings.bibleResourcesEnabled
  const switchOn = typeof explicitSwitch === 'boolean' ? explicitSwitch : hasScriptureFiles
  if (!switchOn) return false
  const explicit = settings.bibleEnrichments?.[id]
  return typeof explicit === 'boolean' ? explicit : BIBLE_ENRICHMENTS[id].default
}

/** Every enrichment's effective value, keyed by id. */
export function resolveBibleEnrichments(
  settings: BibleDataSettings,
  hasScriptureFiles: boolean,
): Record<BibleEnrichmentId, boolean> {
  const out = {} as Record<BibleEnrichmentId, boolean>
  for (const id of BIBLE_ENRICHMENT_IDS) {
    out[id] = resolveBibleEnrichment(settings, id, hasScriptureFiles)
  }
  return out
}

/** The pack layers that the enabled enrichments need, in `BKP_LAYERS` order. */
export function layersForEnrichments(enabled: Readonly<Record<BibleEnrichmentId, boolean>>): BkpLayer[] {
  const needed = new Set<BkpLayer>()
  for (const id of BIBLE_ENRICHMENT_IDS) {
    if (!enabled[id]) continue
    for (const layer of BIBLE_ENRICHMENTS[id].layers) needed.add(layer)
  }
  return BKP_LAYERS.filter((layer) => needed.has(layer))
}

/**
 * Read a stored `bibleEnrichments` value that may arrive as a JSON string
 * (a TEXT column) or as parsed JSON (a JSONB column). Keeps only known ids with
 * boolean values. Anything else counts as unset, so it resolves to the default.
 */
export function readBibleEnrichments(raw: unknown): BibleEnrichmentSettings {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: BibleEnrichmentSettings = {}
  for (const [key, flag] of Object.entries(value)) {
    if (isBibleEnrichmentId(key) && typeof flag === 'boolean') out[key] = flag
  }
  return out
}
