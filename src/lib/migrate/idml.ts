import {
  upgradeLegacyIdmlMetadata,
  type IdmlDiagnostic,
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
  upgrade: Extract<LegacyIdmlUpgradeResult, { ok: true }>,
  carrier: CodexCell,
  physicalOrder: number,
): Record<string, unknown> {
  const locator = upgrade.locator
  const unitKey = [
    "idml",
    locator.memberPath,
    locator.elementPath,
    locator.part,
    locator.slotIndexes.join(","),
  ].join(":")
  return {
    idml: upgrade.metadata,
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

/** Repeatable, side-effect-free readiness classification for one file pair. */
export function classifyIdmlPair(
  pair: {
    source?: CodexNotebookFile
    target?: CodexNotebookFile
  },
  hasOriginalArtifact: boolean,
): IdmlMigrationReadiness {
  if (!isIdmlPair(pair)) return "not-idml"
  if (!hasOriginalArtifact) return "needs-artifact"

  const ordered = pair.target?.cells ?? pair.source?.cells ?? []
  const sourceById = new Map((pair.source?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  const targetById = new Map((pair.target?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  let sawIdmlCell = false
  for (const cell of ordered) {
    const source = sourceById.get(cell.metadata.id)
    const target = targetById.get(cell.metadata.id)
    if (!hasIdmlCellMetadata(source) && !hasIdmlCellMetadata(target)) continue
    sawIdmlCell = true
    const upgraded = upgradeIdmlCell(source, target, target?.value)
    if (!upgraded) return "unsupported-legacy-html"
    if (!upgraded.source.ok) {
      return idmlReadinessFromDiagnostics(upgraded.source.diagnostics)
    }
    if (upgraded.target && !upgraded.target.ok) {
      return idmlReadinessFromDiagnostics(upgraded.target.diagnostics)
    }
  }
  return sawIdmlCell ? "native-ready" : "unsupported-legacy-html"
}

export function buildIdmlMetadataPatchEvents(
  pair: {
    source?: CodexNotebookFile
    target?: CodexNotebookFile
  },
  options: {
    projectId: string
    fileId: string
    author: string
    clientTs: number
  },
): { events: IngestEvent[]; readiness: Exclude<IdmlMigrationReadiness, "needs-artifact"> } {
  if (!isIdmlPair(pair)) return { events: [], readiness: "not-idml" }
  const ordered = pair.target?.cells ?? pair.source?.cells ?? []
  const sourceById = new Map((pair.source?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  const targetById = new Map((pair.target?.cells ?? []).map((cell) => [cell.metadata.id, cell]))
  const events: IngestEvent[] = []
  let sawIdmlCell = false

  for (let physicalOrder = 0; physicalOrder < ordered.length; physicalOrder++) {
    const orderedCell = ordered[physicalOrder]!
    const source = sourceById.get(orderedCell.metadata.id)
    const target = targetById.get(orderedCell.metadata.id)
    if (!hasIdmlCellMetadata(source) && !hasIdmlCellMetadata(target)) continue
    sawIdmlCell = true
    const carrier = metadataCarrier(source, target)
    if (!carrier) continue
    const upgraded = upgradeIdmlCell(source, target, target?.value)
    if (!upgraded) {
      return { events: [], readiness: "unsupported-legacy-html" }
    }
    if (!upgraded.source.ok) {
      return {
        events: [],
        readiness: idmlReadinessFromDiagnostics(upgraded.source.diagnostics),
      }
    }
    if (upgraded.target && !upgraded.target.ok) {
      return {
        events: [],
        readiness: idmlReadinessFromDiagnostics(upgraded.target.diagnostics),
      }
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
        metadata: canonicalIdmlCellMetadata(upgraded.source, carrier, physicalOrder),
        valueHtml: upgraded.source.sourceHtml,
        ...(upgraded.target?.ok && upgraded.target.targetHtml
          ? { targetHtml: upgraded.target.targetHtml }
          : {}),
      },
    })
  }
  return sawIdmlCell
    ? { events, readiness: "native-ready" }
    : { events: [], readiness: "unsupported-legacy-html" }
}
