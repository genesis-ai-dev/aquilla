/**
 * The contract between an importer that cuts an IDML unit into several cells and
 * the exporter that has to hand the package back one whole unit.
 *
 * IDML addresses text by slot, so a cell finer than a slot — a sentence inside a
 * styled run — cannot be a locator of its own. Such cells therefore share their
 * owner unit's locator and carry this bucket to say which part of it they own.
 * On export the siblings are merged back into one translation for that locator
 * (`mergeIdmlSliceTargetHtml`), so the package never sees the split.
 *
 * The group is identified by the shared locator rather than by an id stored here:
 * one source of truth cannot disagree with itself.
 */

import type { IdmlLocator, IdmlSliceRange } from "@aquilla/idml-roundtrip"

export const IDML_REJOIN_VERSION = 1

export interface IdmlRejoinMetadata {
  readonly version: typeof IDML_REJOIN_VERSION
  /** Position of this cell among the siblings sharing its locator, from 0. */
  readonly index: number
  /** How many cells the owner unit was cut into. */
  readonly count: number
  /** The owner slot ranges this cell holds, one per slot of its own. */
  readonly ranges: readonly IdmlSliceRange[]
}

/** Cell metadata key. Sits beside `idml` (the cell's own anchors), not inside it. */
export const IDML_REJOIN_METADATA_KEY = "idmlRejoin"

export function idmlRejoinMetadata(
  index: number,
  count: number,
  ranges: readonly IdmlSliceRange[],
): IdmlRejoinMetadata {
  return { version: IDML_REJOIN_VERSION, index, count, ranges }
}

/**
 * Read the bucket from persisted cell metadata. Anything unrecognised reads as
 * absent, which makes the cell a whole unit — the shape every IDML cell had
 * before slicing existed.
 */
export function readIdmlRejoinMetadata(metadata: unknown): IdmlRejoinMetadata | undefined {
  if (!isRecord(metadata)) return undefined
  const candidate = metadata[IDML_REJOIN_METADATA_KEY]
  if (!isRecord(candidate) || candidate.version !== IDML_REJOIN_VERSION) return undefined
  const { index, count, ranges } = candidate
  if (
    typeof index !== "number"
    || typeof count !== "number"
    || !Number.isInteger(index)
    || !Number.isInteger(count)
    || index < 0
    || count < 1
    || index >= count
    || !Array.isArray(ranges)
    || ranges.length === 0
    || !ranges.every(isSliceRange)
  ) {
    return undefined
  }
  return { version: IDML_REJOIN_VERSION, index, count, ranges }
}

/** Identity of the unit a set of sibling cells was cut from. */
export function idmlRejoinGroupKey(locator: IdmlLocator): string {
  return [
    locator.memberPath,
    locator.elementPath,
    locator.elementId ?? "",
    String(locator.part),
  ].join("\u0000")
}

function isSliceRange(value: unknown): value is IdmlSliceRange {
  if (!isRecord(value)) return false
  const { slot, start, end } = value
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0
    && typeof start === "number" && Number.isInteger(start) && start >= 0
    && typeof end === "number" && Number.isInteger(end) && end >= start
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
