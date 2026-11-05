// HTML on the shared format contract (AQU-2384).
//
// HTML is the clearest case of what "skeleton" means here: `extractHtmlStrings`
// pulls the block text out, and `applyHtmlTranslations` walks the ORIGINAL
// markup again with the same block selector and writes each translation back
// into its block — so the surrounding tags, attributes, lists and tables are
// the skeleton, carried in the source and never reconstructed.
import type { CellData } from "@/hooks/useCells"
import { applyHtmlTranslations, extractHtmlStrings } from "@/lib/parsers/html"
import { descriptorById } from "../descriptors"
import {
  assertSkeletonMatches,
  skeletonText,
  type FormatFilter,
  type FormatParseResult,
  type FormatSkeleton,
  type FormatSource,
} from "../contract"
import { requireText, skeletonFor, textToBytes } from "./shared"

const DESCRIPTOR = descriptorById("html")!

export const htmlFilter: FormatFilter<CellData> = {
  ...DESCRIPTOR,
  async parse(source: FormatSource): Promise<FormatParseResult> {
    const text = requireText(source)
    return {
      skeleton: skeletonFor(DESCRIPTOR, { kind: "text", text }),
      units: extractHtmlStrings(text),
    }
  },
  async build(skeleton: FormatSkeleton, cells: readonly CellData[]) {
    assertSkeletonMatches(DESCRIPTOR, skeleton)
    const html = applyHtmlTranslations(skeletonText(skeleton), [...cells])
    return { bytes: textToBytes(html), mimeType: "text/html;charset=utf-8", unplaced: [] }
  },
}
