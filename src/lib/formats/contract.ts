// One shared contract for file formats (AQU-2384).
//
// Every format Aquilla imports and exports already does the same two things,
// in seven bespoke shapes: it pulls translatable units out of an artifact, and
// it writes translations back into whatever of that artifact was NOT
// translatable. This module names those two things once:
//
//     parse(input)              -> { skeleton, units }
//     build(skeleton, cells)    -> bytes
//
// The `skeleton` is the non-translatable remainder — for Aquilla that is the
// original artifact itself, which is exactly what the existing exporters take
// as their first argument (`exportDocx(rawDocxBytes, cells)`). So this is a
// WRAPPER over the parsers in `../parsers/` and the exporters in
// `../export/exporters/`, not a rewrite of them: `TranslatableString` stays
// the unit type and every per-format test keeps passing unchanged.
//
// Purity rule — this module is TYPES ONLY and imports nothing but other pure
// type modules, so the parse Web Worker and the sync-worker can type against
// it. The descriptor table (`./descriptors`) is pure for the same reason. The
// implementations are bound to descriptors in `./registry`, which is the
// browser/test layer and may reach into DOM-bound parsers.

import type { CellUnit, TranslatableString } from "../parsers/core-types"

/**
 * Where a filter's `parse`/`build` can run.
 *
 * `universal` — pure string/regex/xml-lite work. Safe in the browser, in the
 *   parse Web Worker, and inside a Cloudflare Worker.
 * `dom` — depends on the Window-only `DOMParser`. Main thread only; the
 *   sync-worker's import route must refuse it (`CLIENT_ONLY_FORMATS`).
 *
 * Declared as DATA on the descriptor so the routing tables in
 * `../parsers/parse-text-formats.ts` and
 * `sync-worker/src/external/import-parse-core.ts` can be checked against it
 * instead of drifting from it — see `./registry.test.ts` for the parse core's
 * side and `sync-worker/src/__tests__/format-descriptors-drift.test.ts` for the
 * route's.
 */
export type FormatRuntime = "universal" | "dom"

/**
 * Where each half of a filter can run. They genuinely differ: DOCX *parses*
 * through the DOM-free `xml-lite` reader (which is why `docx` is the one
 * binary format the sync-worker can parse) but *builds* through
 * `docx-runs.ts`, which needs `DOMParser` to read a translation's inline HTML.
 * XLIFF is the mirror image — a DOM parse, a pure-string build.
 */
export interface FormatRuntimes {
  readonly parse: FormatRuntime
  readonly build: FormatRuntime
}

/**
 * How faithfully `build` reproduces the input when nothing was translated —
 * the thing the round-trip ratchet (`./roundtrip-ratchet.test.ts`) asserts.
 *
 * `payload` — `build` PATCHES the skeleton. Everything the filter did not
 *   translate survives untouched (for a package, every member but the
 *   translated content part is byte-identical), and a unit left alone comes
 *   back out of a re-parse unchanged. Whole-file byte-identity is NOT promised
 *   here: the container is rezipped and markup is re-serialized. Making it
 *   byte-exact — encoding, BOM, line endings and all — is AQU-2383's job, and
 *   this field is where that work lands when it does.
 * `regenerative` — `build` does not consult the skeleton at all; it writes a
 *   fresh file from the cells. Round-trip is stability under re-parse, not
 *   byte equality. The CAT interchange format (XLIFF) and the subtitle
 *   formats are all of this kind, and saying so is the point: it is why an
 *   exported .srt is not the imported .srt with two lines changed.
 */
export type RoundTripFidelity = "payload" | "regenerative"

/** The original artifact, carried so `build` can patch rather than regenerate. */
export type FormatSource =
  | { readonly kind: "bytes"; readonly bytes: ArrayBuffer }
  | { readonly kind: "text"; readonly text: string }

/**
 * The non-translatable remainder of a parsed file.
 *
 * Deliberately opaque: a filter may read `source` and nothing else is
 * promised, so a filter can change how it patches without changing callers.
 * `formatId` + `walkVersion` are what make a skeleton refuse a filter that did
 * not produce it — exporting a file parsed by an older walk is a silent
 * mis-mapping, not a recoverable error.
 */
export interface FormatSkeleton {
  readonly formatId: string
  readonly walkVersion: number
  readonly source: FormatSource
}

export interface FormatParseResult {
  readonly skeleton: FormatSkeleton
  readonly units: readonly TranslatableString[]
}

export interface FormatBuildResult {
  readonly bytes: Uint8Array
  readonly mimeType: string
  /** Units `build` could not place. Non-empty means the output is incomplete. */
  readonly unplaced: readonly string[]
}

export interface FormatParseOptions {
  /** What one cell is (AQU-1720); honoured by the document formats. */
  readonly cellUnit?: CellUnit
  /** Display name, used where a parser names its output. */
  readonly name?: string
}

/**
 * The minimum a `build` needs from a workspace cell. `CellData` satisfies it,
 * which is what lets the pure contract describe filters whose implementations
 * take the real `CellData`.
 */
export interface FormatBuildCell {
  readonly id: string
  readonly group: string
  readonly original: string
  readonly translated: string
}

/**
 * One file format: parse it to units, build it back from translations.
 *
 * Generic in the cell type so the contract itself stays pure — the browser
 * filters in `./filters/` instantiate it as `FormatFilter<CellData>`.
 */
export interface FormatFilter<TCell extends FormatBuildCell = FormatBuildCell> {
  readonly id: string
  /** Lower-case, no leading dot. First entry is the canonical extension. */
  readonly extensions: readonly string[]
  /**
   * Bumped whenever this filter's walk changes which units it emits or how it
   * addresses them. A skeleton carries the version it was parsed with, so a
   * build against a newer walk fails loudly instead of writing translations
   * into the wrong blocks.
   */
  readonly walkVersion: number
  readonly runtime: FormatRuntimes
  readonly fidelity: RoundTripFidelity
  parse(source: FormatSource, options?: FormatParseOptions): Promise<FormatParseResult>
  build(skeleton: FormatSkeleton, cells: readonly TCell[]): Promise<FormatBuildResult>
}

/** Thrown when a skeleton and a filter disagree about what produced it. */
export class FormatSkeletonMismatchError extends Error {
  readonly expected: { formatId: string; walkVersion: number }
  readonly received: { formatId: string; walkVersion: number }

  constructor(
    expected: { formatId: string; walkVersion: number },
    received: { formatId: string; walkVersion: number },
  ) {
    super(
      `skeleton was parsed by ${received.formatId} walk ${received.walkVersion}; ` +
        `cannot build with ${expected.formatId} walk ${expected.walkVersion}`,
    )
    this.name = "FormatSkeletonMismatchError"
    this.expected = expected
    this.received = received
  }
}

/**
 * Guard every `build` runs first. A skeleton from another format — or from an
 * older walk of this one — addresses different blocks, so building from it
 * would place translations by a map that no longer describes the file.
 */
export function assertSkeletonMatches(
  filter: Pick<FormatFilter, "id" | "walkVersion">,
  skeleton: FormatSkeleton,
): void {
  if (skeleton.formatId === filter.id && skeleton.walkVersion === filter.walkVersion) return
  throw new FormatSkeletonMismatchError(
    { formatId: filter.id, walkVersion: filter.walkVersion },
    { formatId: skeleton.formatId, walkVersion: skeleton.walkVersion },
  )
}

/** Read a skeleton's artifact as bytes, whichever way it was carried. */
export function skeletonBytes(skeleton: FormatSkeleton): ArrayBuffer {
  if (skeleton.source.kind === "bytes") return skeleton.source.bytes
  const encoded = new TextEncoder().encode(skeleton.source.text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
}

/** Read a skeleton's artifact as text, whichever way it was carried. */
export function skeletonText(skeleton: FormatSkeleton): string {
  if (skeleton.source.kind === "text") return skeleton.source.text
  return new TextDecoder().decode(skeleton.source.bytes)
}
