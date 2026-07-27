import {
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlExportReport,
  type IdmlFormatMetadataV2,
  type IdmlLocator,
  type IdmlSourceManifest,
  type IdmlTranslation,
} from "@aquilla/idml-roundtrip"
import type { CellData } from "@/hooks/useCells"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"

export interface IdmlExportResult {
  blob: Blob
  report: IdmlExportReport
  diagnostics: readonly IdmlDiagnostic[]
}

export interface IdmlExportExecutor {
  parse(bytes: ArrayBuffer): Promise<{ manifest: IdmlSourceManifest }>
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
  const translations = cells.map(cellContract).filter(
    (contract): contract is IdmlTranslation => contract !== null,
  )
  const worker = executor ?? await browserExecutor()

  // Worker requests transfer ownership of their ArrayBuffer. Parse a copy so
  // strict export can still transfer the exact original without cloning it a
  // second time.
  const parsed = await worker.parse(rawIdmlBytes.slice(0))
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

function cellContract(cell: CellData): IdmlTranslation | null {
  const metadata = idmlMetadata(cell.metadata)
  const locator = idmlLocator(cell.metadata)
  if (!metadata || !locator) {
    throw new IdmlWebExportError(
      `Cell ${cell.cellLabel ?? cell.id} has no supported IDML v2 locator. Re-import the original IDML to repair it.`,
    )
  }
  if (!cell.originalHtml) {
    throw new IdmlWebExportError(
      `Cell ${cell.cellLabel ?? cell.id} is missing protected source HTML. Re-import the original IDML to repair it.`,
    )
  }
  if (!cell.translatedHtml) {
    throw new IdmlWebExportError(
      `Cell ${cell.cellLabel ?? cell.id} is missing protected target HTML. Re-import the original IDML to repair it.`,
    )
  }

  const validation = validateIdmlTranslation(
    cell.originalHtml,
    cell.translatedHtml,
    metadata,
  )
  if (!validation.valid) {
    throw new IdmlWebExportError(
      `Cell ${cell.cellLabel ?? cell.id} changed a protected IDML anchor.`,
      validation.diagnostics,
    )
  }
  const hasTranslation = metadata.editableSlotIndexes.some((slotIndex) => (
    (validation.slots[slotIndex] ?? "").length > 0
  ))
  if (!hasTranslation) {
    if (cell.translated.trim().length > 0) {
      throw new IdmlWebExportError(
        `Cell ${cell.cellLabel ?? cell.id} has translated plain text but no text inside its protected IDML slots. Re-open the cell or re-import the original IDML to repair it.`,
      )
    }
    return null
  }
  return {
    unitId: cell.id,
    locator,
    metadata,
    sourceHtml: cell.originalHtml,
    targetHtml: cell.translatedHtml,
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
    parse: (bytes) => parseIdmlInWorker(bytes),
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
