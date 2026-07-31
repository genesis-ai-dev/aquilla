import {
  mergeIdmlSliceTargetHtml,
  projectIdmlUnitToLocator,
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlExportReport,
  type IdmlFormatMetadataV2,
  type IdmlLocator,
  type IdmlSliceTranslation,
  type IdmlSourceManifest,
  type IdmlTranslation,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import type { CellData } from "@/hooks/useCells"
import {
  idmlRejoinGroupKey,
  readIdmlRejoinMetadata,
  type IdmlRejoinMetadata,
} from "@/lib/idml/rejoin"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"

export interface IdmlExportResult {
  blob: Blob
  report: IdmlExportReport
  diagnostics: readonly IdmlDiagnostic[]
}

export interface IdmlExportExecutor {
  parse(bytes: ArrayBuffer): Promise<{
    manifest: IdmlSourceManifest
    /** Needed to rebuild units that were imported as several cells. */
    units: readonly IdmlTranslationUnit[]
  }>
  export(
    bytes: ArrayBuffer,
    translations: readonly IdmlTranslation[],
  ): Promise<{ bytes: Uint8Array; report: IdmlExportReport }>
  validate(
    bytes: ArrayBuffer,
    manifest: IdmlSourceManifest,
  ): Promise<readonly IdmlDiagnostic[]>
}

/**
 * Export an IDML source artifact only after every persisted v2 cell contract
 * proves its source and target anchor sequence. The shared engine performs the
 * final locator/source-hash proof and surgical XML replacement in a worker.
 */
export async function exportIdml(
  rawIdmlBytes: ArrayBuffer,
  cells: readonly CellData[],
  executor?: IdmlExportExecutor,
): Promise<IdmlExportResult> {
  const worker = executor ?? await browserExecutor()

  // Worker requests transfer ownership of their ArrayBuffer. Parse a copy so
  // strict export can still transfer the exact original without cloning it a
  // second time.
  const parsed = await worker.parse(rawIdmlBytes.slice(0))
  const translations = buildTranslations(cells, parsed.units)
  const exported = await worker.export(rawIdmlBytes, translations)
  const validationBytes = exactArrayBuffer(exported.bytes)
  const diagnostics = await worker.validate(validationBytes, parsed.manifest)
  const errors = diagnostics.filter((entry) => entry.severity === "error")
  if (errors.length > 0) {
    throw new IdmlWebExportError(
      "Exported IDML failed structural validation; no translated download was created.",
      errors,
    )
  }
  if (exported.report.missing > 0 || exported.report.rejected > 0) {
    throw new IdmlWebExportError(
      "IDML export did not map every protected translation; no translated download was created.",
      exported.report.warnings,
    )
  }
  return {
    blob: new Blob([exactArrayBuffer(exported.bytes)], { type: IDML_MIME }),
    report: exported.report,
    diagnostics,
  }
}

export class IdmlWebExportError extends Error {
  readonly diagnostics: readonly IdmlDiagnostic[]

  constructor(message: string, diagnostics: readonly IdmlDiagnostic[] = []) {
    super(diagnostics[0]?.message ? `${message} ${diagnostics[0].message}` : message)
    this.name = "IdmlWebExportError"
    this.diagnostics = diagnostics
  }
}

interface CellContract {
  readonly cell: CellData
  readonly locator: IdmlLocator
  readonly metadata: IdmlFormatMetadataV2
  readonly sourceHtml: string
  readonly targetHtml: string
  /** Validated target text per slot of this cell. */
  readonly targetSlots: readonly string[]
  readonly hasTranslation: boolean
  /** Present when the cell is one slice of a larger unit. */
  readonly rejoin?: IdmlRejoinMetadata
}

/**
 * Turn cells into one translation per addressable unit.
 *
 * Most cells are a unit each. Cells cut finer than IDML can address — sentences
 * of a note block — share a locator and are rebuilt into the single translation
 * that locator expects, from the unit as the package has it now.
 */
function buildTranslations(
  cells: readonly CellData[],
  units: readonly IdmlTranslationUnit[],
): readonly IdmlTranslation[] {
  const translations: IdmlTranslation[] = []
  const groups = new Map<string, CellContract[]>()

  for (const cell of cells) {
    const contract = cellContract(cell)
    if (contract.rejoin) {
      const key = idmlRejoinGroupKey(contract.locator)
      groups.set(key, [...(groups.get(key) ?? []), contract])
      continue
    }
    if (!contract.hasTranslation) continue
    translations.push({
      unitId: contract.cell.id,
      locator: contract.locator,
      metadata: contract.metadata,
      sourceHtml: contract.sourceHtml,
      targetHtml: contract.targetHtml,
    })
  }

  for (const group of groups.values()) {
    const merged = mergeSlicedUnit(group, units)
    if (merged) translations.push(merged)
  }
  return translations
}

/**
 * Rebuild one translation from the cells a unit was sliced into.
 *
 * Returns null when no sibling has been translated, which leaves the block as
 * the publisher set it. A sibling that is missing is an error rather than a gap
 * to paper over: silently exporting the source text of a sentence someone has
 * translated is worse than refusing the download.
 */
function mergeSlicedUnit(
  group: readonly CellContract[],
  units: readonly IdmlTranslationUnit[],
): IdmlTranslation | null {
  const siblings = [...group].sort((left, right) => rejoinOf(left).index - rejoinOf(right).index)
  const first = siblings[0]
  if (!first) return null
  const label = cellLabel(first.cell)
  const count = rejoinOf(first).count

  const complete = siblings.length === count && siblings.every((sibling, index) => (
    rejoinOf(sibling).index === index && rejoinOf(sibling).count === count
  ))
  if (!complete) {
    throw new IdmlWebExportError(
      `Cell ${label} is one of ${count} cells that make up a single IDML note block, and ${count - siblings.length} of them are missing from this export. Export the whole file, or re-import the original IDML to repair it.`,
    )
  }
  if (!siblings.some((sibling) => sibling.hasTranslation)) return null

  const owner = ownerUnit(first.locator, units, label)
  const slices = siblings.map((sibling): IdmlSliceTranslation => {
    const { ranges } = rejoinOf(sibling)
    if (ranges.length !== sibling.metadata.slotCount) {
      throw new IdmlWebExportError(
        `Cell ${cellLabel(sibling.cell)} does not describe the part of its note block it holds. Re-import the original IDML to repair it.`,
      )
    }
    return {
      ranges,
      slotTexts: ranges.map((_, position) => (
        sibling.hasTranslation ? sibling.targetSlots[position] ?? "" : undefined
      )),
    }
  })

  try {
    return {
      unitId: owner.id,
      locator: owner.locator,
      metadata: owner.metadata,
      sourceHtml: owner.sourceHtml,
      targetHtml: mergeIdmlSliceTargetHtml(owner, slices),
    }
  } catch (error) {
    throw new IdmlWebExportError(
      `The note block containing cell ${label} could not be reassembled for export. ${
        error instanceof Error ? error.message : String(error)
      } Re-import the original IDML to repair it.`,
    )
  }
}

/** The unit a group's shared locator addresses, as the package has it now. */
function ownerUnit(
  locator: IdmlLocator,
  units: readonly IdmlTranslationUnit[],
  label: string,
): IdmlTranslationUnit {
  const paragraph = units.find((unit) => (
    unit.locator.memberPath === locator.memberPath
    && unit.locator.elementPath === locator.elementPath
    && (!locator.elementId || unit.locator.elementId === locator.elementId)
  ))
  const owner = paragraph ? projectIdmlUnitToLocator(paragraph, locator) : undefined
  if (!owner) {
    throw new IdmlWebExportError(
      `Cell ${label} belongs to a note block this IDML file no longer has. Re-import the original IDML to repair it.`,
    )
  }
  return owner
}

function rejoinOf(contract: CellContract): IdmlRejoinMetadata {
  if (!contract.rejoin) {
    throw new IdmlWebExportError(
      `Cell ${cellLabel(contract.cell)} lost the record of which note block it belongs to. Re-import the original IDML to repair it.`,
    )
  }
  return contract.rejoin
}

function cellLabel(cell: CellData): string {
  return cell.cellLabel ?? cell.id
}

function cellContract(cell: CellData): CellContract {
  const metadata = idmlMetadata(cell.metadata)
  const locator = idmlLocator(cell.metadata)
  if (!metadata || !locator) {
    throw new IdmlWebExportError(
      `Cell ${cellLabel(cell)} has no supported IDML v2 locator. Re-import the original IDML to repair it.`,
    )
  }
  if (!cell.originalHtml) {
    throw new IdmlWebExportError(
      `Cell ${cellLabel(cell)} is missing protected source HTML. Re-import the original IDML to repair it.`,
    )
  }
  if (!cell.translatedHtml) {
    throw new IdmlWebExportError(
      `Cell ${cellLabel(cell)} is missing protected target HTML. Re-import the original IDML to repair it.`,
    )
  }

  const validation = validateIdmlTranslation(
    cell.originalHtml,
    cell.translatedHtml,
    metadata,
  )
  if (!validation.valid) {
    throw new IdmlWebExportError(
      `Cell ${cellLabel(cell)} changed a protected IDML anchor.`,
      validation.diagnostics,
    )
  }
  const hasTranslation = metadata.editableSlotIndexes.some((slotIndex) => (
    (validation.slots[slotIndex] ?? "").length > 0
  ))
  if (!hasTranslation && cell.translated.trim().length > 0) {
    throw new IdmlWebExportError(
      `Cell ${cellLabel(cell)} has translated plain text but no text inside its protected IDML slots. Re-open the cell or re-import the original IDML to repair it.`,
    )
  }
  const rejoin = readIdmlRejoinMetadata(cell.metadata)
  return {
    cell,
    locator,
    metadata,
    sourceHtml: cell.originalHtml,
    targetHtml: cell.translatedHtml,
    targetSlots: validation.slots,
    hasTranslation,
    ...(rejoin ? { rejoin } : {}),
  }
}

function idmlMetadata(metadata: CellData["metadata"]): IdmlFormatMetadataV2 | undefined {
  if (!isRecord(metadata)) return undefined
  const candidate = metadata.idml
  if (!isRecord(candidate) || candidate.version !== 2) return undefined
  return candidate as unknown as IdmlFormatMetadataV2
}

function idmlLocator(metadata: CellData["metadata"]): IdmlLocator | undefined {
  if (!isRecord(metadata)) return undefined
  const aquillaImport = metadata.aquillaImport
  const candidate = isRecord(aquillaImport)
    ? aquillaImport.sourceLocator
    : metadata.idmlLocator
  if (!isRecord(candidate) || candidate.kind !== "idml") return undefined
  return candidate as unknown as IdmlLocator
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function browserExecutor(): Promise<IdmlExportExecutor> {
  const {
    parseIdmlInWorker,
    exportIdmlInWorker,
    validateIdmlExportInWorker,
  } = await import("@/lib/idml/idml-worker-client")
  return {
    parse: async (bytes) => {
      const { manifest, units } = await parseIdmlInWorker(bytes)
      return { manifest, units }
    },
    export: (bytes, translations) => exportIdmlInWorker(bytes, translations),
    validate: (bytes, manifest) => validateIdmlExportInWorker(bytes, manifest),
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}
