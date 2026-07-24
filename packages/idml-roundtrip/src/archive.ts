import { IdmlError } from "./errors.js"
import type { IdmlLimits, IdmlPackageInspection } from "./types.js"

export async function inspectIdml(
  _bytes: Uint8Array | ArrayBuffer,
  _limits?: Partial<IdmlLimits>,
): Promise<IdmlPackageInspection> {
  throw new IdmlError("EXPORT_REJECTED", "IDML archive inspection is not implemented")
}
