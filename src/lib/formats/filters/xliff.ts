// XLIFF on the shared format contract (AQU-2384).
//
// `fidelity: "regenerative"` — `exportXliff` writes a fresh XLIFF 1.2 from the
// cells and never reads the imported file, so an XLIFF 2.0 import exports as
// 1.2 and inline <g>/<x> tags do not survive. The contract records that rather
// than hiding it; the ratchet therefore asserts re-parse stability, not bytes.
import type { CellData } from "@/hooks/useCells"
import { parseXliff } from "@/lib/parsers/xliff"
import { exportXliff } from "@/lib/export/exporters/xliff"
import { descriptorById } from "../descriptors"
import {
  assertSkeletonMatches,
  type FormatFilter,
  type FormatParseResult,
  type FormatSkeleton,
  type FormatSource,
} from "../contract"
import { blobToBytes, requireText, skeletonFor } from "./shared"

const DESCRIPTOR = descriptorById("xliff")!

export const xliffFilter: FormatFilter<CellData> = {
  ...DESCRIPTOR,
  async parse(source: FormatSource): Promise<FormatParseResult> {
    const text = requireText(source)
    return {
      skeleton: skeletonFor(DESCRIPTOR, { kind: "text", text }),
      units: parseXliff(text),
    }
  },
  async build(skeleton: FormatSkeleton, cells: readonly CellData[]) {
    assertSkeletonMatches(DESCRIPTOR, skeleton)
    const blob = exportXliff([...cells])
    return {
      bytes: await blobToBytes(blob),
      mimeType: "application/xliff+xml;charset=utf-8",
      unplaced: [],
    }
  },
}
