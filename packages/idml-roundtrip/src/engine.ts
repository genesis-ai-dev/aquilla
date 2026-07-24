import { IdmlError } from "./errors.js"
import type {
  IdmlExportOptions,
  IdmlExportResult,
  IdmlDiagnostic,
  IdmlParseOptions,
  IdmlParseResult,
  IdmlSemanticProfile,
  IdmlSourceManifest,
  IdmlTranslation,
} from "./types.js"

export async function parseIdml(
  _bytes: Uint8Array | ArrayBuffer,
  _profile: IdmlSemanticProfile = "generic",
  _options?: IdmlParseOptions,
): Promise<IdmlParseResult> {
  throw new IdmlError("EXPORT_REJECTED", "IDML parsing is not implemented")
}

export async function exportIdml(
  _bytes: Uint8Array | ArrayBuffer,
  _translations: readonly IdmlTranslation[],
  _options: IdmlExportOptions,
): Promise<IdmlExportResult> {
  throw new IdmlError("EXPORT_REJECTED", "IDML export is not implemented")
}

export async function validateExport(
  _bytes: Uint8Array | ArrayBuffer,
  _manifest: IdmlSourceManifest,
): Promise<readonly IdmlDiagnostic[]> {
  throw new IdmlError("EXPORT_REJECTED", "IDML export validation is not implemented")
}
