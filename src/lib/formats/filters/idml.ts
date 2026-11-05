// IDML on the shared format contract (AQU-2384).
//
// IDML is the format that justifies the contract's shape. Its export is not
// "write the cells out": the shared engine proves every persisted cell's
// protected anchor sequence against the package and refuses to produce a
// download if one translation cannot be placed. That is a skeleton patch in
// the strictest sense, and `exportIdml` THROWS rather than hand back a
// partially-translated package — so a caller must supply a translation for
// every unit, which is exactly what the ratchet's identity pass does.
//
// Both halves run through a Web Worker by default. The executors are injectable
// because that worker does not exist under vitest (and because the Biblica
// adapter already injects its own) — `createIdmlFilter` is how the ratchet
// drives the real engine in-process.
import type { CellData } from "@/hooks/useCells"
import {
  extractIdmlStrings,
  idmlUnitsToTranslatableStrings,
  type IdmlParseExecutor,
} from "@/lib/parsers/idml"
import { exportIdml, type IdmlExportExecutor } from "@/lib/export/exporters/idml"
import { descriptorById } from "../descriptors"
import {
  assertSkeletonMatches,
  skeletonBytes,
  type FormatFilter,
  type FormatParseResult,
  type FormatSkeleton,
  type FormatSource,
} from "../contract"
import { blobToBytes, requireBytes, skeletonFor } from "./shared"

const DESCRIPTOR = descriptorById("idml")!
const IDML_MIME = "application/vnd.adobe.indesign-idml-package"

export interface IdmlFilterDeps {
  /** Engine parse. Defaults to the browser Web Worker client. */
  readonly parse?: IdmlParseExecutor
  /** Engine parse+export+validate. Defaults to the browser Web Worker client. */
  readonly executor?: IdmlExportExecutor
}

export function createIdmlFilter(deps: IdmlFilterDeps = {}): FormatFilter<CellData> {
  return {
    ...DESCRIPTOR,
    async parse(source: FormatSource): Promise<FormatParseResult> {
      const bytes = requireBytes(DESCRIPTOR.id, source)
      // The engine worker TRANSFERS ownership of the buffer it is handed, so
      // the walk gets a copy and the skeleton keeps the original intact for
      // the build. Getting this backwards yields a detached ArrayBuffer at
      // export time, not a wrong answer, which is why it is done here once.
      const units = deps.parse
        ? await extractIdmlStrings(bytes.slice(0), deps.parse)
        : await extractIdmlStrings(bytes.slice(0))
      return { skeleton: skeletonFor(DESCRIPTOR, source), units }
    },
    async build(skeleton: FormatSkeleton, cells: readonly CellData[]) {
      assertSkeletonMatches(DESCRIPTOR, skeleton)
      const result = await exportIdml(skeletonBytes(skeleton), cells, deps.executor)
      return {
        bytes: await blobToBytes(result.blob),
        mimeType: IDML_MIME,
        // `exportIdml` throws rather than return an incomplete package, so a
        // result in hand means nothing was left unplaced. Reported from the
        // engine's own report so the contract never asserts it independently.
        unplaced: result.report.missing > 0 || result.report.rejected > 0
          ? result.report.warnings.map((warning) => warning.unitId ?? warning.code)
          : [],
      }
    },
  }
}

export const idmlFilter: FormatFilter<CellData> = createIdmlFilter()

/** Re-exported so an IDML caller can map engine units without reaching past
 *  the contract into the parser module. */
export { idmlUnitsToTranslatableStrings }
