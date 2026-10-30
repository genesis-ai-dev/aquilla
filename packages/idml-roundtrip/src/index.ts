export { IdmlError } from "./errors.js"
export { IDML_SCHEMA_VERSION } from "./types.js"
export type * from "./types.js"

export { inspectIdml } from "./archive.js"
export {
  parseIdml,
  exportIdml,
  releaseOversizedNoBreakInPackage,
  validateExport,
  partitionIdmlUnitAtLineBreaks,
  projectIdmlUnitToLocator,
  sliceIdmlUnit,
  mergeIdmlSliceTargetHtml,
} from "./engine.js"
export { releaseOversizedNoBreak } from "./no-break.js"
export { renderIdmlUnitHtml, validateIdmlTranslation } from "./html.js"
export { upgradeLegacyIdmlMetadata } from "./legacy.js"
export {
  extractIdmlStyleCatalog,
  extractIdmlStyleCatalogFromDocument,
  styleCatalogForSlots,
} from "./style-catalog.js"
