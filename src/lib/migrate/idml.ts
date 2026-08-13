import {
  IdmlError,
  parseIdml,
  upgradeLegacyIdmlMetadata,
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlSourceManifest,
  type IdmlTranslationUnit,
  type LegacyIdmlUpgradeResult,
} from "@aquilla/idml-roundtrip"
import type { CodexCell, CodexNotebookFile } from "../codex-editor/types"
import { sourceCellMetadataPatchEventId } from "./ids"
import type { IngestEvent } from "./types"

export const IDML_PROFILE_ID = "builtin:idml-roundtrip"
export const IDML_PROFILE_VERSION = "2"

export type IdmlMigrationReadiness =
  | "native-ready"
  | "needs-artifact"
  | "ambiguous-locator"
  | "unsupported-legacy-html"
  | "not-idml"

export interface IdmlCellUpgrade {
  source: LegacyIdmlUpgradeResult
  target?: LegacyIdmlUpgradeResult
}

export interface IdmlCellProof {
  readonly cellId: string
  readonly unit: IdmlTranslationUnit
  readonly sourceHtml: string
  readonly targetHtml?: string
}

export interface IdmlMigrationAssessment {
  readonly readiness: IdmlMigrationReadiness
  readonly sourceSha256?: string
  readonly manifest?: IdmlSourceManifest
  readonly cells: ReadonlyMap<string, IdmlCellProof>
  readonly diagnostics: readonly IdmlDiagnostic[]
}

/**
 * Preserve target-side presentation order (including milestones) without
 * dropping source-only cells from partially translated legacy notebooks.
 */
export function orderedCodexPairCells(pair: {
  source?: CodexNotebookFile
  target?: CodexNotebookFile
}): CodexCell[] {
  const ordered = [...(pair.target?.cells ?? pair.source?.cells ?? [])]
  const seen = new Set(ordered.map((cell) => cell.metadata.id))
  for (const cell of pair.source?.cells ?? []) {
    if (seen.has(cell.metadata.id)) continue
    ordered.push(cell)
    seen.add(cell.metadata.id)
  }
  return ordered
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function legacyIdmlStructure(cell: CodexCell | undefined): Record<string, unknown> | undefined {
  return record(cell?.metadata.data?.idmlStructure)
}

function v2IdmlMetadata(cell: CodexCell | undefined): Record<string, unknown> | undefined {
  return record(cell?.metadata.idml)
}

function hasIdmlCellMetadata(cell: CodexCell | undefined): boolean {
  return Boolean(legacyIdmlStructure(cell) || v2IdmlMetadata(cell))
}

function idmlSourceLocator(cell: CodexCell | undefined): Record<string, unknown> | undefined {
  return record(record(cell?.metadata.aquillaImport)?.sourceLocator)
}

export function isIdmlNotebook(notebook: CodexNotebookFile | undefined): boolean {
  if (!notebook) return false
  if (/\.idml$/i.test(notebook.metadata.originalName ?? "")) return true
  return notebook.cells.some((cell) => Boolean(
    legacyIdmlStructure(cell)
    || v2IdmlMetadata(cell)
    || idmlSourceLocator(cell)?.kind === "idml",
  ))
}

export function isIdmlPair(pair: {
  source?: CodexNotebookFile
  target?: CodexNotebookFile
}): boolean {
  return isIdmlNotebook(pair.source) || isIdmlNotebook(pair.target)
}

function metadataCarrier(source: CodexCell | undefined, target: CodexCell | undefined): CodexCell | undefined {
  if (legacyIdmlStructure(source) || v2IdmlMetadata(source)) return source
  if (legacyIdmlStructure(target) || v2IdmlMetadata(target)) return target
  return source ?? target
}

/**
 * Upgrade one legacy Codex cell using its exact source/target HTML. The shared
 * engine proves the XML block, locator, style-slot identities, and anchors; no
 * migration-specific approximation is allowed.
 */
export function upgradeIdmlCell(
  source: CodexCell | undefined,
  target: CodexCell | undefined,
  targetHtml?: string,
): IdmlCellUpgrade | null {
  const carrier = metadataCarrier(source, target)
  if (!carrier || (!legacyIdmlStructure(carrier) && !v2IdmlMetadata(carrier))) return null
  const sourceHtml = source?.value ?? target?.metadata.data?.originalText
  const base = {
    metadata: carrier.metadata,
    sourceLocator: idmlSourceLocator(carrier),
    sourceHtml,
  }
  const sourceUpgrade = upgradeLegacyIdmlMetadata(base)
  const targetUpgrade = targetHtml === undefined
    ? undefined
    : upgradeLegacyIdmlMetadata({ ...base, targetHtml })
  return { source: sourceUpgrade, ...(targetUpgrade ? { target: targetUpgrade } : {}) }
}

export function canonicalIdmlCellMetadata(
  proof: Pick<IdmlTranslationUnit, "locator" | "metadata">,
  carrier: CodexCell,
  physicalOrder: number,
): Record<string, unknown> {
  const locator = proof.locator
  const unitKey = [
    "idml",
    locator.memberPath,
    locator.elementPath,
    locator.part,
    locator.slotIndexes.join(","),
  ].join(":")
  return {
    idml: proof.metadata,
    aquillaImport: {
      version: 1,
      profileId: IDML_PROFILE_ID,
      profileVersion: IDML_PROFILE_VERSION,
      unitKey,
      kind: "paragraph",
      displayLabel: null,
      address: {
        scheme: "document",
        memberPath: locator.memberPath,
        blockPath: locator.elementPath,
        segment: locator.part,
      },
      sourceLocator: locator,
      physicalOrder,
      fidelity: "content-only",
    },
    // Retain the exact legacy proof alongside v2. It is inert provenance and
    // makes audits/retries explainable without depending on the old notebook.
    ...(legacyIdmlStructure(carrier)
      ? {
          legacyCodex: {
            idmlStructure: legacyIdmlStructure(carrier),
            ...(record(carrier.metadata.data?.relationships)
              ? { relationships: carrier.metadata.data?.relationships }
              : {}),
          },
        }
      : {}),
  }
}

type UpgradeFailureReadiness = "ambiguous-locator" | "unsupported-legacy-html"

export function idmlReadinessFromDiagnostics(
  diagnostics: readonly IdmlDiagnostic[],
): UpgradeFailureReadiness {
  return diagnostics.some((diagnostic) => (
    diagnostic.code === "LOCATOR_MISSING"
    || diagnostic.code === "LOCATOR_DUPLICATED"
    || diagnostic.code === "LOCATOR_STALE"
    || diagnostic.code === "SOURCE_HASH_MISMATCH"
  ))
    ? "ambiguous-locator"
    : "unsupported-legacy-html"
}

function emptyAssessment(
  readiness: IdmlMigrationReadiness,
  diagnostics: readonly IdmlDiagnostic[] = [],
): IdmlMigrationAssessment {
  return {
    readiness,
    cells: new Map(),
    diagnostics,
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function exactLocatorMatch(
  claimed: Extract<LegacyIdmlUpgradeResult, { ok: true }>["locator"],
  actual: IdmlTranslationUnit["locator"],
): boolean {
  // Legacy Codex locators used an XPath-like path rooted at `/Story`, while
  // the v2 structural parser records the exact namespace-aware package path.
  // A stable InDesign Self id is therefore the authoritative identity when it
  // exists on both sides; path equality is required when no stable id exists.
  const sameElementIdentity = claimed.elementId !== undefined
    && actual.elementId !== undefined
    ? claimed.elementId === actual.elementId
    : claimed.elementPath === actual.elementPath
  return claimed.memberPath === actual.memberPath
    && sameElementIdentity
    && claimed.part === actual.part
    && claimed.sourceBlockHash === actual.sourceBlockHash
    && sameNumbers(claimed.slotIndexes, actual.slotIndexes)
    && (claimed.storyId === undefined || claimed.storyId === actual.storyId)
}

function exactSourceTextMatch(
  unit: IdmlTranslationUnit,
  candidateHtml: string,
): boolean {
  const validation = validateIdmlTranslation(unit.sourceHtml, candidateHtml, unit.metadata)
  return validation.valid
    && validation.slots.length === unit.slots.length
    && validation.slots.every((text, index) => text === unit.slots[index].text)
}

function migrationDiagnostic(
  code: IdmlDiagnostic["code"],
  message: string,
  unitId?: string,
): IdmlDiagnostic {
  return {
    code,
    severity: "error",
    message,
    ...(unitId ? { unitId } : {}),
  }
}

function hasBlockingUnsupportedLiteral(diagnostics: readonly IdmlDiagnostic[]): boolean {
  return diagnostics.some((entry) => (
    entry.code === "UNSUPPORTED_CONSTRUCT"
    && entry.details?.unsupportedDisposition !== "preserved-nonliteral"
  ))
}

/**
 * Prove a legacy Codex IDML pair against the immutable original bytes.
 *
 * Embedded sourceBlockXml/idmlStructure is only a claim. A cell becomes v2
 * eligible after the shared engine parses the original package and exactly one
 * parsed unit agrees on identity, structural hash, slot indexes, and source
 * slot text.
 */
export async function assessIdmlPair(
  pair: {
    source?: CodexNotebookFile
    target?: CodexNotebookFile
  },
  originalBytes?: Uint8Array | ArrayBuffer,
): Promise<IdmlMigrationAssessment> {
  if (!isIdmlPair(pair)) return emptyAssessment("not-idml")
  if (!originalBytes) return emptyAssessment("needs-artifact")

  let parsed: Awaited<ReturnType<typeof parseIdml>>
  try {
    parsed = await parseIdml(originalBytes, "generic")
  } catch (error) {
    const diagnostics = error instanceof IdmlError
      ? error.diagnostics
      : [migrationDiagnostic(
          "UNSUPPORTED_CONSTRUCT",
          `Original IDML could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        )]
    return emptyAssessment("unsupported-legacy-html", diagnostics)
  }

  const ordered = orderedCodexPairCells(pair)
  const sourceById = new Map((pair.source?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  const targetById = new Map((pair.target?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  const proofs = new Map<string, IdmlCellProof>()
  const matchedUnitIds = new Set<string>()
  const diagnostics: IdmlDiagnostic[] = [...parsed.diagnostics]
  if (hasBlockingUnsupportedLiteral(diagnostics)) {
    return emptyAssessment("unsupported-legacy-html", diagnostics)
  }
  let sawIdmlCell = false

  for (const cell of ordered) {
    const source = sourceById.get(cell.metadata.id)
    const target = targetById.get(cell.metadata.id)
    if (!hasIdmlCellMetadata(source) && !hasIdmlCellMetadata(target)) continue
    sawIdmlCell = true
    const upgraded = upgradeIdmlCell(source, target, target?.value)
    if (!upgraded) return emptyAssessment("unsupported-legacy-html", diagnostics)
    const sourceUpgrade = upgraded.source
    if (!sourceUpgrade.ok) {
      return emptyAssessment(
        idmlReadinessFromDiagnostics(sourceUpgrade.diagnostics),
        [...diagnostics, ...sourceUpgrade.diagnostics],
      )
    }
    if (upgraded.target && !upgraded.target.ok) {
      return emptyAssessment(
        idmlReadinessFromDiagnostics(upgraded.target.diagnostics),
        [...diagnostics, ...upgraded.target.diagnostics],
      )
    }

    const candidates = parsed.units.filter((unit) => (
      exactLocatorMatch(sourceUpgrade.locator, unit.locator)
      && exactSourceTextMatch(unit, sourceUpgrade.sourceHtml)
    ))
    if (candidates.length !== 1) {
      const diagnostic = migrationDiagnostic(
        candidates.length === 0 ? "LOCATOR_STALE" : "LOCATOR_DUPLICATED",
        candidates.length === 0
          ? `Legacy IDML cell ${cell.metadata.id} does not exactly match the parsed original`
          : `Legacy IDML cell ${cell.metadata.id} matches multiple parsed original units`,
      )
      return emptyAssessment("ambiguous-locator", [...diagnostics, diagnostic])
    }
    const unit = candidates[0]!
    if (matchedUnitIds.has(unit.id)) {
      return emptyAssessment("ambiguous-locator", [
        ...diagnostics,
        migrationDiagnostic(
          "LOCATOR_DUPLICATED",
          `Multiple legacy IDML cells resolve to parsed unit ${unit.id}`,
          unit.id,
        ),
      ])
    }

    const targetHtml = upgraded.target?.ok ? upgraded.target.targetHtml : undefined
    if (targetHtml !== undefined) {
      const targetValidation = validateIdmlTranslation(unit.sourceHtml, targetHtml, unit.metadata)
      if (!targetValidation.valid) {
        return emptyAssessment("unsupported-legacy-html", [
          ...diagnostics,
          ...targetValidation.diagnostics,
        ])
      }
    }
    matchedUnitIds.add(unit.id)
    proofs.set(cell.metadata.id, {
      cellId: cell.metadata.id,
      unit,
      sourceHtml: unit.sourceHtml,
      ...(targetHtml !== undefined ? { targetHtml } : {}),
    })
  }
  if (!sawIdmlCell) {
    return emptyAssessment("unsupported-legacy-html", [
      ...diagnostics,
      migrationDiagnostic(
        "ANCHOR_MISSING",
        "IDML notebook has no cells with legacy or v2 IDML metadata",
      ),
    ])
  }
  const unmatchedUnits = parsed.units.filter((unit) => !matchedUnitIds.has(unit.id))
  if (unmatchedUnits.length > 0) {
    return emptyAssessment("unsupported-legacy-html", [
      ...diagnostics,
      migrationDiagnostic(
        "ANCHOR_MISSING",
        `${unmatchedUnits.length} parsed IDML translation unit(s) are absent from the legacy notebook; re-import is required`,
      ),
    ])
  }
  return {
    readiness: "native-ready",
    sourceSha256: parsed.manifest.sourceSha256,
    manifest: parsed.manifest,
    cells: proofs,
    diagnostics,
  }
}

export function buildIdmlMetadataPatchEvents(
  pair: {
    source?: CodexNotebookFile
    target?: CodexNotebookFile
  },
  assessment: IdmlMigrationAssessment,
  options: {
    projectId: string
    fileId: string
    author: string
    clientTs: number
  },
): { events: IngestEvent[]; readiness: IdmlMigrationReadiness } {
  if (!isIdmlPair(pair)) return { events: [], readiness: "not-idml" }
  if (assessment.readiness !== "native-ready" || !assessment.sourceSha256) {
    return { events: [], readiness: assessment.readiness }
  }
  const ordered = orderedCodexPairCells(pair)
  const sourceById = new Map((pair.source?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  const targetById = new Map((pair.target?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  const events: IngestEvent[] = []

  for (let physicalOrder = 0; physicalOrder < ordered.length; physicalOrder++) {
    const orderedCell = ordered[physicalOrder]!
    const source = sourceById.get(orderedCell.metadata.id)
    const target = targetById.get(orderedCell.metadata.id)
    if (!hasIdmlCellMetadata(source) && !hasIdmlCellMetadata(target)) continue
    const carrier = metadataCarrier(source, target)
    const proof = assessment.cells.get(orderedCell.metadata.id)
    if (!carrier || !proof) {
      return { events: [], readiness: "ambiguous-locator" }
    }
    events.push({
      id: sourceCellMetadataPatchEventId(
        options.projectId,
        options.fileId,
        orderedCell.metadata.id,
      ),
      schemaVersion: 2,
      kind: "source.cell.metadata.patch",
      fileId: options.fileId,
      cellId: orderedCell.metadata.id,
      parentId: null,
      author: options.author,
      clientTs: options.clientTs,
      payload: {
        version: 1,
        metadata: {
          ...canonicalIdmlCellMetadata(proof.unit, carrier, physicalOrder),
          idmlMigration: {
            version: 2,
            readiness: "native-ready",
            sourceSha256: assessment.sourceSha256,
          },
        },
        valueHtml: proof.sourceHtml,
        ...(proof.targetHtml !== undefined
          ? { targetHtml: proof.targetHtml }
          : {}),
      },
    })
  }
  return events.length > 0
    ? { events, readiness: "native-ready" }
    : { events: [], readiness: "unsupported-legacy-html" }
}
