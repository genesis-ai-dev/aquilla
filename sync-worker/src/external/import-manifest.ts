// Worker-side compiler for the normalized import contract (AQU-635).
//
// The SPA and external/agent surfaces use the same semantic envelope. The SPA
// derives it from deterministic parsers; PlanImport may submit it explicitly
// after bounded artifact inspection or an AI-assisted recipe proposal. This
// module never executes model-generated code. Recipes are declarative,
// versioned provenance only; cells still pass through ordinary validation and
// compile to the canonical event perimeter.

import {
  IMPORT_UNIT_KINDS,
  NORMALIZED_IMPORT_VERSION,
  ROUND_TRIP_FIDELITIES,
  type ImportUnitKind,
  type NormalizedImportSummary,
  type RoundTripFidelity,
} from '../../../shared/import-contract'

export interface PlanImportManifest extends Omit<NormalizedImportSummary, 'unitCount' | 'warningCounts'> {
  memberPath?: string
  warningCounts?: Record<string, number>
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
  if (value === 'text' || value === undefined) return 'segment'
  return (IMPORT_UNIT_KINDS as readonly string[]).includes(value)
    ? value as ImportUnitKind
    : 'other'
}

function defaultFidelity(fileType: string): RoundTripFidelity {
  if (['audio', 'video'].includes(fileType.toLowerCase())) return 'preserved-only'
  // Native is an evidence-backed declaration, never an extension-based guess.
  // Callers that preserved + inspected an artifact may request it explicitly;
  // preparePlanImport verifies the profile/format pair before staging.
  return 'content-only'
}

function validateAddressShape(
  cell: PlanImportCell,
  kind: ImportUnitKind,
  path: string,
): string[] {
  const issues: string[] = []
  const address = cell.address
  const locator = cell.sourceLocator
  if (address !== undefined) {
    const scheme = address.scheme
    if (typeof scheme !== 'string') issues.push(`${path}.address.scheme must be a string`)
    if (scheme === 'scripture') {
      if (typeof address.book !== 'string' || !Number.isInteger(address.chapter) || typeof address.verse !== 'string') {
        issues.push(`${path}.address has invalid scripture fields`)
      }
      if (cell.canonicalRef) {
        const expected = `${String(address.book).toUpperCase()} ${address.chapter}:${address.verse}`
        if (expected !== cell.canonicalRef.toUpperCase()) issues.push(`${path}.address does not match canonicalRef`)
      }
    } else if (scheme === 'scripture-structure') {
      if (typeof address.book !== 'string' || !(address.chapter === null || Number.isInteger(address.chapter)) || typeof address.marker !== 'string' || !Number.isInteger(address.occurrence)) {
        issues.push(`${path}.address has invalid scripture-structure fields`)
      }
    } else if (scheme === 'document') {
      if (typeof address.memberPath !== 'string' || typeof address.blockPath !== 'string' || !Number.isInteger(address.segment)) {
        issues.push(`${path}.address has invalid document fields`)
      }
    } else if (scheme === 'translation-unit') {
      if (!['xliff', 'tmx'].includes(String(address.format)) || typeof address.unitId !== 'string') {
        issues.push(`${path}.address has invalid translation-unit fields`)
      }
    } else if (scheme === 'timeline') {
      if (!Number.isInteger(address.cue)) issues.push(`${path}.address.cue must be an integer`)
    } else if (scheme === 'sequence') {
      if (!Number.isInteger(address.index)) issues.push(`${path}.address.index must be an integer`)
    } else if (scheme === 'custom') {
      if (typeof address.recipeId !== 'string' || !Number.isInteger(address.record)) {
        issues.push(`${path}.address has invalid custom fields`)
      }
    } else if (scheme !== undefined) {
      issues.push(`${path}.address.scheme is unsupported`)
    }
  }
  if (locator !== undefined) {
    const locatorKind = locator.kind
    if (typeof locatorKind !== 'string') issues.push(`${path}.sourceLocator.kind must be a string`)
    if (locatorKind === 'usfm') {
      if (typeof locator.ref !== 'string' || typeof locator.marker !== 'string') issues.push(`${path}.sourceLocator has invalid usfm fields`)
    } else if (locatorKind === 'package-block') {
      if (typeof locator.memberPath !== 'string' || typeof locator.blockPath !== 'string' || !Number.isInteger(locator.segment)) {
        issues.push(`${path}.sourceLocator has invalid package-block fields`)
      }
    } else if (locatorKind === 'translation-unit') {
      if (!['xliff', 'tmx'].includes(String(locator.format)) || typeof locator.unitId !== 'string') {
        issues.push(`${path}.sourceLocator has invalid translation-unit fields`)
      }
    } else if (locatorKind === 'cue') {
      if (!Number.isInteger(locator.index)) issues.push(`${path}.sourceLocator.index must be an integer`)
    } else if (locatorKind === 'sequence') {
      if (!Number.isInteger(locator.index)) issues.push(`${path}.sourceLocator.index must be an integer`)
    } else if (locatorKind === 'recipe') {
      if (typeof locator.recipeId !== 'string' || !Number.isInteger(locator.record)) {
        issues.push(`${path}.sourceLocator has invalid recipe fields`)
      }
    } else if (locatorKind !== undefined) {
      issues.push(`${path}.sourceLocator.kind is unsupported`)
    }
  }
  if ((kind === 'heading' || kind === 'paratext') && address?.scheme === 'scripture') {
    issues.push(`${path}.address cannot describe structural content as a scripture verse`)
  }
  if (address && locator) {
    const scheme = typeof address.scheme === 'string' ? address.scheme : ''
    // Address is semantic identity; sourceLocator is physical provenance, so
    // cross-scheme pairs are valid (for example a custom recipe record that
    // maps to GEN 1:1). When both describe the same scheme, their duplicated
    // fields must agree.
    if (scheme === 'scripture' && locator.kind === 'usfm') {
      const ref = `${String(address.book).toUpperCase()} ${address.chapter}:${address.verse}`
      if (String(locator.ref).toUpperCase() !== ref.toUpperCase() || locator.marker !== 'v') {
        issues.push(`${path}.sourceLocator does not match scripture address`)
      }
    } else if (scheme === 'scripture-structure' && locator.kind === 'usfm') {
      if (locator.marker !== address.marker || locator.occurrence !== address.occurrence) {
        issues.push(`${path}.sourceLocator does not match scripture-structure address`)
      }
    } else if (scheme === 'document' && locator.kind === 'package-block') {
      if (
        locator.memberPath !== address.memberPath
        || locator.blockPath !== address.blockPath
        || locator.segment !== address.segment
      ) issues.push(`${path}.sourceLocator does not match document address`)
    } else if (scheme === 'translation-unit' && locator.kind === 'translation-unit') {
      if (
        locator.format !== address.format
        || locator.unitId !== address.unitId
        || (locator.segmentId ?? null) !== (address.segmentId ?? null)
      ) issues.push(`${path}.sourceLocator does not match translation-unit address`)
    } else if (scheme === 'timeline' && locator.kind === 'cue') {
      if (
        locator.index !== address.cue
        || (locator.startMs ?? null) !== (address.startMs ?? null)
        || (locator.endMs ?? null) !== (address.endMs ?? null)
      ) issues.push(`${path}.sourceLocator does not match timeline address`)
    } else if (scheme === 'sequence' && locator.kind === 'sequence') {
      if (locator.index !== address.index) issues.push(`${path}.sourceLocator does not match sequence address`)
    } else if (scheme === 'custom' && locator.kind === 'recipe') {
      if (locator.recipeId !== address.recipeId || locator.record !== address.record) {
        issues.push(`${path}.sourceLocator does not match custom address`)
      }
    }
  }
  return issues
}

function computedWarningCounts(input: PlanImportInput): Record<string, number> {
  const counts: Record<string, number> = {}
  const add = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  for (const cell of input.cells) {
    const kind = normalizedKind(cell.type)
    if (!cell.content.trim()) add('empty-source')
    if (kind === 'verse' && !cell.canonicalRef) add('verse-without-canonical-ref')
  }
  return counts
}

function defaultAddress(
  cell: PlanImportCell,
  kind: ImportUnitKind,
  index: number,
  contentOrder: number,
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
    displayLabel: kind === 'heading' || kind === 'paratext' ? null : String(contentOrder),
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
    if (manifest.version !== NORMALIZED_IMPORT_VERSION) issues.push('manifest.version must be 1')
    if (!nonEmpty(manifest.profileId)) issues.push('manifest.profileId must be a non-empty string')
    if (!nonEmpty(manifest.profileVersion)) issues.push('manifest.profileVersion must be a non-empty string')
    if (!(ROUND_TRIP_FIDELITIES as readonly string[]).includes(manifest.fidelity)) {
      issues.push('manifest.fidelity is unsupported')
    }
    if (manifest.fidelity === 'verified-recipe' && !manifest.recipe?.roundTripVerified) {
      issues.push('verified-recipe fidelity requires recipe.roundTripVerified=true')
    }
    if (manifest.recipe) {
      if (manifest.recipe.version !== NORMALIZED_IMPORT_VERSION) issues.push('manifest.recipe.version must be 1')
      if (!nonEmpty(manifest.recipe.id)) issues.push('manifest.recipe.id must be a non-empty string')
      if (!nonEmpty(manifest.recipe.name)) issues.push('manifest.recipe.name must be a non-empty string')
      if (!nonEmpty(manifest.recipe.inputFormat)) issues.push('manifest.recipe.inputFormat must be a non-empty string')
      if (manifest.recipe.strategy !== 'records') {
        issues.push('manifest.recipe.strategy is unsupported')
      }
      if (!['ai', 'user'].includes(manifest.recipe.proposedBy)) {
        issues.push('manifest.recipe.proposedBy is unsupported')
      }
    }
  }

  const explicitKeys = new Set<string>()
  const physicalOrders = new Set<number>()
  input.cells.forEach((cell, index) => {
    const path = `cells[${index}]`
    if (cell.unitKey !== undefined) {
      if (!nonEmpty(cell.unitKey)) issues.push(`${path}.unitKey must be a non-empty string`)
      else if (explicitKeys.has(cell.unitKey)) issues.push(`${path}.unitKey duplicates ${cell.unitKey}`)
      else explicitKeys.add(cell.unitKey)
    }
    if (cell.physicalOrder !== undefined && (!Number.isInteger(cell.physicalOrder) || cell.physicalOrder < 0)) {
      issues.push(`${path}.physicalOrder must be a non-negative integer`)
    } else if (cell.physicalOrder !== undefined && physicalOrders.has(cell.physicalOrder)) {
      issues.push(`${path}.physicalOrder duplicates ${cell.physicalOrder}`)
    } else if (cell.physicalOrder !== undefined) {
      physicalOrders.add(cell.physicalOrder)
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
    const verse = kind === 'verse' ? cell.canonicalRef?.match(SCRIPTURE_VERSE_RE) : null
    if (verse && cell.displayLabel !== undefined && cell.displayLabel !== verse[3]) {
      issues.push(`${path}.displayLabel must match its canonical verse number`)
    }
    issues.push(...validateAddressShape(cell, kind, path))
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
  let contentOrder = 0

  const units = input.cells.map((cell, index): CompiledPlanImportUnit => {
    const kind = normalizedKind(cell.type)
    if (kind !== 'heading' && kind !== 'paratext') contentOrder += 1
    const defaults = defaultAddress(cell, kind, index, contentOrder)
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
      // Warning counts are derived from the submitted cells. A caller cannot
      // suppress warnings by declaring a more flattering summary.
      warningCounts: computedWarningCounts(input),
      ...(manifest?.memberPath ? { memberPath: manifest.memberPath } : {}),
      ...(manifest?.recipe ? { recipe: manifest.recipe } : {}),
    },
    units,
  }
}
