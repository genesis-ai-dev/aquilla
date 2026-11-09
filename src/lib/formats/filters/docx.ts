// DOCX on the shared format contract (AQU-2384). Wrapper only — the walk is
// still `extractDocxStrings` and the injection is still `exportDocx`.
import type { CellData } from "@/hooks/useCells"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { exportDocx } from "@/lib/export/exporters/docx"
import { descriptorById } from "../descriptors"
import {
  assertSkeletonMatches,
  skeletonBytes,
  type FormatFilter,
  type FormatParseOptions,
  type FormatParseResult,
  type FormatSkeleton,
  type FormatSource,
} from "../contract"
import { blobToBytes, requireBytes, skeletonFor } from "./shared"

const DESCRIPTOR = descriptorById("docx")!
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export const docxFilter: FormatFilter<CellData> = {
  ...DESCRIPTOR,
  async parse(source: FormatSource, options?: FormatParseOptions): Promise<FormatParseResult> {
    const bytes = requireBytes(DESCRIPTOR.id, source)
    // The walk consumes the buffer's contents only; the skeleton keeps the
    // same buffer so a build patches the package the units came out of.
    const units = await extractDocxStrings(bytes, { cellUnit: options?.cellUnit ?? "sentence" })
    return { skeleton: skeletonFor(DESCRIPTOR, source), units }
  },
  async build(skeleton: FormatSkeleton, cells: readonly CellData[]) {
    assertSkeletonMatches(DESCRIPTOR, skeleton)
    const result = await exportDocx(skeletonBytes(skeleton), [...cells])
    return { bytes: await blobToBytes(result.blob), mimeType: DOCX_MIME, unplaced: [] }
  },
}
