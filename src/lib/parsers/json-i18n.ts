import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import type { CellData } from "@/hooks/useCells"

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

export function extractJsonStrings(content: string): TranslatableString[] {
  const parsed = parseJson(content, "i18n resource file")
  const results: TranslatableString[] = []
  walkStringLeaves(parsed, "", (path, value) => {
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

/**
 * Re-serialize the original JSON with each string leaf replaced by the
 * corresponding cell's `translated` (falling back to `cell.original`).
 * Alignment is positional: the export walk is identical to the extract walk,
 * so the Nth visited leaf pairs with the Nth cell. If the cell list is
 * shorter than the leaf count, remaining leaves keep their original value.
 */
export function exportJson(originalContent: string, cells: CellData[]): Blob {
  const parsed = parseJson(originalContent, "original i18n resource file")
  let index = 0
  const replaced = walkStringLeaves(parsed, "", () => {
    if (index >= cells.length) return undefined
    const cell = cells[index]
    index += 1
    return cell.translated || cell.original
  })
  const json = JSON.stringify(replaced, null, detectIndent(originalContent)) + "\n"
  return new Blob([json], { type: "application/json;charset=utf-8" })
}
