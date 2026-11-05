// PPTX on the shared format contract (AQU-2384). Wrapper only.
import type { CellData } from "@/hooks/useCells"
import { extractPptxStrings } from "@/lib/parsers/pptx"
import { exportPptx } from "@/lib/export/exporters/pptx"
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

const DESCRIPTOR = descriptorById("pptx")!
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

export const pptxFilter: FormatFilter<CellData> = {
  ...DESCRIPTOR,
  async parse(source: FormatSource): Promise<FormatParseResult> {
    const bytes = requireBytes(DESCRIPTOR.id, source)
    const units = await extractPptxStrings(bytes)
    return { skeleton: skeletonFor(DESCRIPTOR, source), units }
  },
  async build(skeleton: FormatSkeleton, cells: readonly CellData[]) {
    assertSkeletonMatches(DESCRIPTOR, skeleton)
    const result = await exportPptx(skeletonBytes(skeleton), [...cells])
    return { bytes: await blobToBytes(result.blob), mimeType: PPTX_MIME, unplaced: [] }
  },
}
