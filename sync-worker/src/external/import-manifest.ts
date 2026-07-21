// Worker-side compiler for the normalized import contract (AQU-635).
//
// The SPA and external/agent surfaces use the same semantic envelope. The SPA
// derives it from deterministic parsers; PlanImport may submit it explicitly
// after bounded artifact inspection or an AI-assisted recipe proposal. This
// module never executes model-generated code. Recipes are declarative,
// versioned provenance only; cells still pass through ordinary validation and
// compile to the canonical event perimeter.

export type ImportFidelity =
  | 'native'
  | 'verified-recipe'
  | 'content-only'
  | 'preserved-only'

export type ImportUnitKind =
  | 'verse'
  | 'heading'
  | 'paratext'
  | 'paragraph'
  | 'list'
  | 'blockquote'
  | 'cue'
  | 'segment'
  | 'media'
  | 'other'

export interface PlanImportRecipe {
  version: 1
  name: string
  inputFormat: string
  strategy: 'delimiter' | 'regex' | 'json-path' | 'xml-path' | 'model-assisted'
  config: Record<string, unknown>
  roundTripVerified?: boolean
}

export interface PlanImportManifest {
  version: 1
  profileId: string
  profileVersion: string
  deterministic: boolean
  fidelity: ImportFidelity
  memberPath?: string
  warningCounts?: Record<string, number>
  recipe?: PlanImportRecipe
}

export interface PlanImportVariant {
  /** Durable workflow-lane key. The empty string is the legacy default lane. */
  laneId: string
  /** Content language is descriptive and intentionally distinct from laneId. */
  languageTag?: string
  content: string
  contentHtml?: string
}

export interface PlanImportCell {
  /** Cell identifier; a fresh UUIDv7 is minted when omitted. */
  id?: string
  content: string
  contentHtml?: string
  canonicalRef?: string
  /** Logical section label (chapter/act/…); retained for legacy callers. */
  section?: string
  type?: string
  unitKey?: string
  displayLabel?: string | null
  address?: Record<string, unknown>
  sourceLocator?: Record<string, unknown>
  physicalOrder?: number
  startMs?: number
  endMs?: number
  speaker?: string
  paragraphStart?: boolean
  metadata?: Record<string, unknown>
  /** Zero or more target variants sharing this source unit. */
  variants?: PlanImportVariant[]
}

export interface PlanImportInput {
  fileType: string
  cells: PlanImportCell[]
  manifest?: PlanImportManifest
}

export interface CompiledPlanImportUnit {
  cell: PlanImportCell
  type: string
  canonicalRef?: string
  sequenceIndex: number
  startMs?: number
  endMs?: number
  metadata: Record<string, unknown>
}

export interface CompiledPlanImport {
  fileSummary: Record<string, unknown>
  units: CompiledPlanImportUnit[]
}

const SCRIPTURE_VERSE_RE = /^([1-3]?[A-Z]{2,3})\s+(\d+):(\d+[a-z]?(?:-\d+[a-z]?)?)$/i

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizedKind(value: string | undefined): ImportUnitKind {
  switch (value) {
    case 'verse':
    case 'heading':
    case 'paratext':
    case 'paragraph':
    case 'list':
    case 'blockquote':
    case 'cue':
    case 'segment':
    case 'media':
    case 'other':
      return value
    case 'text':
    case undefined:
      return 'segment'
    default:
      return 'other'
  }
}

function defaultFidelity(fileType: string): ImportFidelity {
  if (['usfm', 'usx', 'sfm', 'docx', 'pptx'].includes(fileType.toLowerCase())) return 'native'
  if (['audio', 'video'].includes(fileType.toLowerCase())) return 'preserved-only'
  return 'content-only'
}

function defaultAddress(
  cell: PlanImportCell,
  kind: ImportUnitKind,
  index: number,
): {
  unitKey: string
  displayLabel: string | null
  address: Record<string, unknown>
  sourceLocator: Record<string, unknown>
} {
  const verse = cell.canonicalRef?.match(SCRIPTURE_VERSE_RE)
  if (verse) {
    const ref = `${verse[1].toUpperCase()} ${Number(verse[2])}:${verse[3]}`
    return {
      unitKey: `scripture:${ref}`,
      displayLabel: kind === 'verse' ? verse[3] : null,
      address: {
        scheme: 'scripture',
        book: verse[1].toUpperCase(),
        chapter: Number(verse[2]),
        verse: verse[3],
      },
      sourceLocator: { kind: 'usfm', ref, marker: 'v' },
    }
  }

  const ordinal = index + 1
  return {
    unitKey: `sequence:${ordinal}`,
    displayLabel: kind === 'heading' || kind === 'paratext' ? null : String(ordinal),
    address: { scheme: 'sequence', index: ordinal },
    sourceLocator: { kind: 'sequence', index: ordinal },
  }
}

/** Strict validation for explicit normalized fields; legacy flat PlanImport
 * cells remain accepted and are deterministically upgraded by compile below. */
export function validatePlanImportManifest(input: PlanImportInput): string[] {
  const issues: string[] = []
  const manifest = input.manifest
  if (manifest) {
    if (manifest.version !== 1) issues.push('manifest.version must be 1')
    if (!nonEmpty(manifest.profileId)) issues.push('manifest.profileId must be a non-empty string')
    if (!nonEmpty(manifest.profileVersion)) issues.push('manifest.profileVersion must be a non-empty string')
    if (!['native', 'verified-recipe', 'content-only', 'preserved-only'].includes(manifest.fidelity)) {
      issues.push('manifest.fidelity is unsupported')
    }
    if (manifest.fidelity === 'verified-recipe' && !manifest.recipe?.roundTripVerified) {
      issues.push('verified-recipe fidelity requires recipe.roundTripVerified=true')
    }
    if (manifest.recipe) {
      if (manifest.recipe.version !== 1) issues.push('manifest.recipe.version must be 1')
      if (!nonEmpty(manifest.recipe.name)) issues.push('manifest.recipe.name must be a non-empty string')
      if (!nonEmpty(manifest.recipe.inputFormat)) issues.push('manifest.recipe.inputFormat must be a non-empty string')
      if (!['delimiter', 'regex', 'json-path', 'xml-path', 'model-assisted'].includes(manifest.recipe.strategy)) {
        issues.push('manifest.recipe.strategy is unsupported')
      }
    }
  }

  const explicitKeys = new Set<string>()
  input.cells.forEach((cell, index) => {
    const path = `cells[${index}]`
    if (cell.unitKey !== undefined) {
      if (!nonEmpty(cell.unitKey)) issues.push(`${path}.unitKey must be a non-empty string`)
      else if (explicitKeys.has(cell.unitKey)) issues.push(`${path}.unitKey duplicates ${cell.unitKey}`)
      else explicitKeys.add(cell.unitKey)
    }
    if (cell.physicalOrder !== undefined && (!Number.isInteger(cell.physicalOrder) || cell.physicalOrder < 0)) {
      issues.push(`${path}.physicalOrder must be a non-negative integer`)
    }
    if ((cell.startMs === undefined) !== (cell.endMs === undefined)) {
      issues.push(`${path}.startMs and endMs must be supplied together`)
    } else if (cell.startMs !== undefined && cell.endMs! <= cell.startMs) {
      issues.push(`${path}.endMs must be after startMs`)
    }
    const kind = normalizedKind(cell.type)
    if ((kind === 'heading' || kind === 'paratext') && cell.displayLabel != null) {
      issues.push(`${path}.displayLabel must be null for structural content`)
    }
    const lanes = new Set<string>()
    for (const [variantIndex, variant] of (cell.variants ?? []).entries()) {
      if (lanes.has(variant.laneId)) {
        issues.push(`${path}.variants[${variantIndex}].laneId is duplicated`)
      }
      lanes.add(variant.laneId)
    }
  })
  return issues
}

/** Upgrade legacy cells and compile explicit manifest cells into the compact
 * metadata envelope used by the browser importer. */
export function compilePlanImport(input: PlanImportInput): CompiledPlanImport {
  const manifest = input.manifest
  const occurrences = new Map<string, number>()
  const profileId = manifest?.profileId ?? `agent:${input.fileType.toLowerCase()}`
  const profileVersion = manifest?.profileVersion ?? '1'
  const fidelity = manifest?.fidelity ?? defaultFidelity(input.fileType)

  const units = input.cells.map((cell, index): CompiledPlanImportUnit => {
    const kind = normalizedKind(cell.type)
    const defaults = defaultAddress(cell, kind, index)
    const keyBase = cell.unitKey ?? defaults.unitKey
    const occurrence = (occurrences.get(keyBase) ?? 0) + 1
    occurrences.set(keyBase, occurrence)
    const unitKey = occurrence === 1 ? keyBase : `${keyBase}#${occurrence}`
    const physicalOrder = cell.physicalOrder ?? index
    const importMetadata = {
      version: 1,
      profileId,
      profileVersion,
      unitKey,
      kind,
      displayLabel: cell.displayLabel === undefined ? defaults.displayLabel : cell.displayLabel,
      address: cell.address ?? defaults.address,
      sourceLocator: cell.sourceLocator ?? defaults.sourceLocator,
      physicalOrder,
      fidelity,
    }
    return {
      cell,
      type: kind,
      ...(cell.canonicalRef ? { canonicalRef: cell.canonicalRef } : {}),
      sequenceIndex: physicalOrder,
      ...(cell.startMs === undefined ? {} : { startMs: cell.startMs }),
      ...(cell.endMs === undefined ? {} : { endMs: cell.endMs }),
      metadata: {
        ...(cell.metadata ?? {}),
        ...(cell.section ? { section: cell.section } : {}),
        ...(cell.speaker ? { speaker: cell.speaker } : {}),
        ...(cell.paragraphStart ? { paragraphStart: true } : {}),
        aquillaImport: importMetadata,
      },
    }
  })

  return {
    fileSummary: {
      version: 1,
      profileId,
      profileVersion,
      deterministic: manifest?.deterministic ?? true,
      fidelity,
      unitCount: units.length,
      warningCounts: manifest?.warningCounts ?? {},
      ...(manifest?.memberPath ? { memberPath: manifest.memberPath } : {}),
      ...(manifest?.recipe ? { recipe: manifest.recipe } : {}),
    },
    units,
  }
}
