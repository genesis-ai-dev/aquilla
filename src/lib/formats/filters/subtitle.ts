// SRT and VTT on the shared format contract (AQU-2384).
//
// Both are `regenerative`: the exporters write a fresh cue list from the
// cells' own timings, so the skeleton is kept for provenance and not read.
// The timing fields are the one real shape mismatch in the wrapper set — the
// parsers emit `start`/`end` on a unit, the exporters read `startTime`/
// `endTime` off a cell — so `subtitleCellsFromUnits` is the only place that
// translation lives.
import type { CellData } from "@/hooks/useCells"
import { extractSrtStrings, extractVttStrings } from "@/lib/parsers/subtitle"
import { exportSrt } from "@/lib/export/exporters/srt"
import { exportVtt } from "@/lib/export/exporters/vtt"
import type { TranslatableString } from "@/lib/parsers/core-types"
import { descriptorById } from "../descriptors"
import {
  assertSkeletonMatches,
  type FormatFilter,
  type FormatParseResult,
  type FormatSkeleton,
  type FormatSource,
} from "../contract"
import { blobToBytes, requireText, skeletonFor } from "./shared"

const SRT = descriptorById("srt")!
const VTT = descriptorById("vtt")!

/**
 * Carry a parsed cue's timings onto the cell shape the subtitle exporters
 * read. Exported because a caller round-tripping subtitles has to do this and
 * there should be exactly one copy of it.
 */
export function subtitleCellsFromUnits(
  units: readonly TranslatableString[],
  translationFor: (unit: TranslatableString) => string,
): CellData[] {
  return units.map((unit): CellData => {
    const translated = translationFor(unit)
    return {
      id: unit.id,
      fileId: "format-filter",
      original: unit.original,
      translated,
      context: unit.context,
      group: unit.group,
      type: unit.type,
      status: translated.trim() ? "unvalidated" : "empty",
      validationStatus: translated.trim() ? "none" : "empty",
      activeValidators: [],
      validationHistory: [],
      history: [],
      threads: [],
      ...(unit.start !== undefined ? { startTime: unit.start } : {}),
      ...(unit.end !== undefined ? { endTime: unit.end } : {}),
      ...(unit.speaker !== undefined ? { speaker: unit.speaker } : {}),
    }
  })
}

export const srtFilter: FormatFilter<CellData> = {
  ...SRT,
  async parse(source: FormatSource): Promise<FormatParseResult> {
    const text = requireText(source)
    return { skeleton: skeletonFor(SRT, { kind: "text", text }), units: extractSrtStrings(text) }
  },
  async build(skeleton: FormatSkeleton, cells: readonly CellData[]) {
    assertSkeletonMatches(SRT, skeleton)
    return {
      bytes: await blobToBytes(exportSrt([...cells])),
      mimeType: "application/x-subrip;charset=utf-8",
      unplaced: [],
    }
  },
}

export const vttFilter: FormatFilter<CellData> = {
  ...VTT,
  async parse(source: FormatSource): Promise<FormatParseResult> {
    const text = requireText(source)
    return { skeleton: skeletonFor(VTT, { kind: "text", text }), units: extractVttStrings(text) }
  },
  async build(skeleton: FormatSkeleton, cells: readonly CellData[]) {
    assertSkeletonMatches(VTT, skeleton)
    return {
      bytes: await blobToBytes(exportVtt([...cells], undefined)),
      mimeType: "text/vtt;charset=utf-8",
      unplaced: [],
    }
  },
}
