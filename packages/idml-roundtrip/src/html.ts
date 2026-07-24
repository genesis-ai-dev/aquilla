import { IdmlError } from "./errors.js"
import type {
  IdmlFormatMetadataV2,
  IdmlTranslationUnit,
  IdmlTranslationValidation,
} from "./types.js"

export function renderIdmlUnitHtml(_unit: IdmlTranslationUnit): string {
  throw new IdmlError("EXPORT_REJECTED", "IDML HTML rendering is not implemented")
}

export function validateIdmlTranslation(
  _sourceHtml: string,
  _targetHtml: string,
  _metadata: IdmlFormatMetadataV2,
): IdmlTranslationValidation {
  throw new IdmlError("EXPORT_REJECTED", "IDML translation validation is not implemented")
}
