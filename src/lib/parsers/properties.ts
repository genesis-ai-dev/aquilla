import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./core-types"
import type { ExportCellFields } from "./core-types"

/** Java .properties importer/exporter.
 *
 * Import: one TranslatableString per `key=value` pair (also `key:value` and
 * `key = value`), with comments (#/!), blank lines, escaped separators in keys
 * (`\=`, `\:`), `\uXXXX` unicode escapes and trailing-backslash line
 * continuations handled per the java.util.Properties load format.
 *
 * Export: line-based reconstruction of the original file — comments, blank
 * lines, key order and each line's separator style are preserved; only the
 * value text is substituted.
 */

const WS = /[ \t\f]/

/** A physical/logical line of a .properties file, classified for export. */
type PropLine =
  | { kind: "raw"; text: string }
  | { kind: "pair"; prefix: string; rawKey: string; key: string; separator: string; rawValue: string }

/** Decode \n \t \r \f \uXXXX \\ (and `\X` → `X`) per Properties.load. */
function decodeEscapes(raw: string): string {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== "\\") { out += ch; continue }
    const esc = raw[++i]
    if (esc === undefined) break
    switch (esc) {
      case "n": out += "\n"; break
      case "t": out += "\t"; break
      case "r": out += "\r"; break
      case "f": out += "\f"; break
      case "u": {
        const hex = raw.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4 }
        else out += "u" // malformed \u — keep the literal char
        break
      }
      default: out += esc // covers \= \: \\ \# \! and anything else
    }
  }
  return out
}

/** Odd number of trailing backslashes ⇒ the line continues onto the next. */
function continuesOnNextLine(line: string): boolean {
  let n = 0
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) n++
  return n % 2 === 1
}

/** Split a logical line at the first unescaped `=` or `:`. */
function splitPair(logical: string): Extract<PropLine, { kind: "pair" }> | null {
  let i = 0
  while (i < logical.length && WS.test(logical[i])) i++
  const keyStart = i
  let sepIndex = -1
  for (; i < logical.length; i++) {
    const ch = logical[i]
    if (ch === "\\") { i++; continue } // skip escaped char (handles \= \:)
    if (ch === "=" || ch === ":") { sepIndex = i; break }
  }
  if (sepIndex === -1) return null
  let keyEnd = sepIndex
  while (keyEnd > keyStart && WS.test(logical[keyEnd - 1])) keyEnd--
  if (keyEnd === keyStart) return null // separator with no key
  let valStart = sepIndex + 1
  while (valStart < logical.length && WS.test(logical[valStart])) valStart++
  const rawKey = logical.slice(keyStart, keyEnd)
  return {
    kind: "pair",
    prefix: logical.slice(0, keyStart),
    rawKey,
    key: decodeEscapes(rawKey),
    separator: logical.slice(keyEnd, valStart), // "=", ":", " = ", ": ", …
    rawValue: logical.slice(valStart),
  }
}

/** Classify a .properties file into raw (comment/blank) and key/value lines.
 *  A logical line spanning continuations is collapsed into one PropLine. */
function parseLines(content: string): PropLine[] {
  const lines = content.split(/\r\n|\r|\n/)
  const out: PropLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      out.push({ kind: "raw", text: line })
      continue
    }
    // Join continuation lines: drop the trailing backslash and the next
    // line's leading whitespace (java.util.Properties behavior).
    let logical = line
    while (continuesOnNextLine(logical) && i + 1 < lines.length) {
      logical = logical.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, "")
    }
    const pair = splitPair(logical)
    out.push(pair ?? { kind: "raw", text: logical })
  }
  return out
}

export function extractPropertiesStrings(content: string): TranslatableString[] {
  const results: TranslatableString[] = []
  for (const line of parseLines(content)) {
    if (line.kind !== "pair") continue
    const value = decodeEscapes(line.rawValue)
    if (value === "") continue // skip empty values
    results.push({
      id: uuid(),
      original: value,
      translated: "",
      context: line.key,
      group: line.key,
      type: "text",
    })
  }
  return results
}

/** Re-encode a translated value for a .properties line. Backslashes and
 *  control characters are escaped; non-Latin-1 characters are deliberately
 *  left as UTF-8 — modern properties readers (Java 9+ ResourceBundle, and
 *  virtually every non-Java toolchain) accept UTF-8, so we skip \uXXXX
 *  transcoding and keep the file human-readable. */
function encodeValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\f/g, "\\f")
}

/** Rebuild the .properties file with translated values substituted in place.
 *  Comments, blank lines, key order, and per-line separator style are
 *  preserved. Cells match by `group === key`, falling back to positional
 *  order over the file's key lines; a missing/empty translation falls back
 *  to the original value. */
export function exportProperties(originalContent: string, cells: ExportCellFields[]): Blob {
  const byGroup = new Map<string, ExportCellFields>()
  for (const cell of cells) {
    if (cell.group && !byGroup.has(cell.group)) byGroup.set(cell.group, cell)
  }
  let pairIndex = 0
  const out = parseLines(originalContent).map((line) => {
    if (line.kind === "raw") return line.text
    const match = byGroup.get(line.key) ?? cells[pairIndex]
    pairIndex++
    const translated = match?.translated ?? ""
    const value = translated !== "" ? encodeValue(translated) : line.rawValue
    return line.prefix + line.rawKey + line.separator + value
  })
  return new Blob([out.join("\n")], { type: "text/plain;charset=utf-8" })
}
