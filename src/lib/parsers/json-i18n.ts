import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./core-types"
import type { ExportCellFields } from "./core-types"

/**
 * JSON i18n-resource importer/exporter (e.g. locale files like en.json).
 *
 * Import walks the parsed document depth-first in key order and emits one
 * TranslatableString per non-empty leaf string value; the string's JSON path
 * (`app.title`, `messages[2]`, `["weird key"]`) doubles as `context` and
 * `group`. Export re-walks the ORIGINAL document with the same deterministic
 * traversal and replaces the Nth string leaf with the Nth cell's translation,
 * so matching is purely positional and structure/non-string values are
 * preserved byte-for-byte (modulo re-serialization with detected indent).
 */

/** Keys safe for dot notation (`parent.key`); everything else gets `["…"]`. */
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/

function joinPath(parent: string, key: string): string {
  if (IDENTIFIER_KEY.test(key)) {
    return parent ? `${parent}.${key}` : key
  }
  return `${parent}[${JSON.stringify(key)}]`
}

/**
 * Depth-first walk over a parsed JSON value. Calls `visit` for every
 * NON-EMPTY leaf string; a string return value replaces the leaf in place,
 * `undefined` leaves it untouched. Containers are mutated directly and the
 * (possibly replaced) node is returned so a root-level string also works.
 */
function walkStringLeaves(
  node: unknown,
  path: string,
  visit: (path: string, value: string) => string | undefined,
): unknown {
  if (typeof node === "string") {
    if (node.length === 0) return node
    const replacement = visit(path, node)
    return replacement === undefined ? node : replacement
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = walkStringLeaves(node[i], `${path}[${i}]`, visit)
    }
    return node
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      obj[key] = walkStringLeaves(obj[key], joinPath(path, key), visit)
    }
    return node
  }
  // Numbers, booleans, null: not translatable — pass through untouched.
  return node
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON in ${label}: ${detail}`)
  }
}

/** A translatable string leaf: its JSON path (`app.title`, `messages[2]`) and value. */
export interface JsonStringLeaf {
  path: string
  value: string
}

/**
 * Enumerate every non-empty string leaf in a JSON document as `{ path, value }`
 * in the same deterministic depth-first order `extractJsonStrings` uses. This is
 * the primitive a key-picker UI consumes to let the user choose which paths are
 * translatable (AQU-525) — group by top-level key, show `value` as a sample.
 */
export function listJsonStringPaths(content: string): JsonStringLeaf[] {
  const parsed = parseJson(content, "JSON source file")
  const leaves: JsonStringLeaf[] = []
  walkStringLeaves(parsed, "", (path, value) => {
    leaves.push({ path, value })
    return undefined
  })
  return leaves
}

/**
 * Does `leafPath` fall under one of the selected paths? A selection entry
 * matches its own leaf exactly OR any descendant — the boundary after the
 * prefix must be a path separator (`.` for object keys, `[` for array
 * indices / bracketed keys) so `app` selects `app.title` and `messages[0]`
 * but never `application.title`. An empty selection matches nothing.
 */
export function matchesJsonSelection(leafPath: string, include: readonly string[]): boolean {
  return include.some(
    (sel) =>
      leafPath === sel ||
      leafPath.startsWith(`${sel}.`) ||
      leafPath.startsWith(`${sel}[`),
  )
}

/** Options for {@link extractJsonStrings}. */
export interface ExtractJsonOptions {
  /**
   * Path selection: only string leaves under these paths become translatable
   * cells (see {@link matchesJsonSelection}). Omit to extract every string leaf
   * (back-compat default). An empty array yields no cells.
   */
  include?: readonly string[]
}

export function extractJsonStrings(
  content: string,
  options: ExtractJsonOptions = {},
): TranslatableString[] {
  const parsed = parseJson(content, "i18n resource file")
  const { include } = options
  const results: TranslatableString[] = []
  walkStringLeaves(parsed, "", (path, value) => {
    if (include && !matchesJsonSelection(path, include)) return undefined
    results.push({
      id: uuid(),
      original: value,
      translated: "",
      context: path,
      group: path,
      type: "text",
    })
    return undefined
  })
  return results
}

/**
 * Detect the original file's indentation from its first indented line.
 * Tab wins if the line starts with one; otherwise the run of leading spaces
 * (2 vs 4). Falls back to 2 when the file has no indented lines (minified).
 */
function detectIndent(content: string): string | number {
  const match = content.match(/^([ \t]+)\S/m)
  if (!match) return 2
  return match[1].startsWith("\t") ? "\t" : match[1].length
}

/** Options for {@link exportJson}. */
export interface ExportJsonOptions {
  /**
   * Align cells to leaves by JSON path (`cell.context`) instead of positionally.
   * REQUIRED when the cells came from a filtered `extractJsonStrings({ include })`:
   * only leaves whose path matches a cell are replaced, every other leaf (the
   * un-selected structure) is preserved untouched. Falls back to positional when
   * false/omitted so full-document exports keep their existing behavior.
   */
  keyed?: boolean
}

/**
 * Re-serialize the original JSON with translated string leaves substituted in.
 *
 * Default (positional): the export walk is identical to the extract walk, so the
 * Nth visited leaf pairs with the Nth cell; leaves beyond the cell list keep
 * their original value.
 *
 * Keyed (`{ keyed: true }`): each cell is placed by its `context` JSON path, so a
 * partial selection round-trips correctly — only the selected leaves change and
 * the rest of the structure (including string leaves the user chose NOT to
 * translate) is preserved byte-for-byte. A cell falls back to `cell.original`
 * when its translation is empty.
 */
export function exportJson(
  originalContent: string,
  cells: ExportCellFields[],
  options: ExportJsonOptions = {},
): Blob {
  const parsed = parseJson(originalContent, "original i18n resource file")

  let replaced: unknown
  if (options.keyed) {
    const byPath = new Map<string, ExportCellFields>()
    for (const cell of cells) byPath.set(cell.context, cell)
    replaced = walkStringLeaves(parsed, "", (path) => {
      const cell = byPath.get(path)
      if (!cell) return undefined
      return cell.translated || cell.original
    })
  } else {
    let index = 0
    replaced = walkStringLeaves(parsed, "", () => {
      if (index >= cells.length) return undefined
      const cell = cells[index]
      index += 1
      return cell.translated || cell.original
    })
  }

  const json = JSON.stringify(replaced, null, detectIndent(originalContent)) + "\n"
  return new Blob([json], { type: "application/json;charset=utf-8" })
}
