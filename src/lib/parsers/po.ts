/**
 * GNU gettext PO importer / exporter.
 *
 * Import (`extractPoStrings`): parses PO entries — comments (#, #., #:, #,, #|),
 * `msgctxt`, `msgid`, `msgid_plural`, `msgstr`, `msgstr[N]` — with multi-line
 * string continuation (adjacent quoted lines concatenate). The header entry
 * (msgid "") is skipped. A plain entry emits one TranslatableString; a plural
 * entry emits one per msgstr[N] index present (or per index 0..1 if none).
 *
 * Export (`exportPo`): TEXT-BASED reconstruction. The original file passes
 * through byte-for-byte — header, comments, flags, msgid lines — except the
 * msgstr / msgstr[N] value lines, which are rewritten with the matching cell's
 * `translated` (positional match in extraction order). A fallback keeps the
 * original msgstr when the cell has no translation.
 *
 * KNOWN acceptable loss: a multi-line original msgstr that receives a
 * translation is collapsed to a single quoted line on export (gettext treats
 * adjacent quoted lines as pure concatenation, so the value is identical).
 */

import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import type { CellData } from "@/hooks/useCells"

// ─── PO string escaping ──────────────────────────────────────────────────────

/** Unescape a PO double-quoted string body: \" \\ \n \t. Unknown escapes pass through verbatim. */
function unescapePo(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "\\" && i + 1 < s.length) {
      const n = s[++i]
      if (n === "n") out += "\n"
      else if (n === "t") out += "\t"
      else if (n === '"') out += '"'
      else if (n === "\\") out += "\\"
      else out += "\\" + n
    } else {
      out += c
    }
  }
  return out
}

/** Escape a value back into a PO double-quoted string body. */
function escapePo(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
}

/** Extract + unescape the content between the first and last `"` of a line fragment. */
function parseQuotedPart(fragment: string): string {
  const first = fragment.indexOf('"')
  const last = fragment.lastIndexOf('"')
  if (first === -1 || last <= first) return ""
  return unescapePo(fragment.slice(first + 1, last))
}

// ─── line-level entry parser (shared by import and export) ───────────────────

/** One msgstr / msgstr[N] occurrence, with the line span it occupies. */
interface MsgstrSlot {
  /** null for plain `msgstr`; N for `msgstr[N]`. */
  index: number | null
  value: string
  /** Line index of the keyword line. */
  lineStart: number
  /** Line index of the last continuation line (== lineStart when single-line). */
  lineEnd: number
}

interface PoEntry {
  msgctxt?: string
  msgid?: string
  msgidPlural?: string
  /** References collected from `#:` comment lines. */
  references: string[]
  msgstrSlots: MsgstrSlot[]
}

type Field =
  | { kind: "msgctxt" | "msgid" | "msgid_plural" }
  | { kind: "msgstr"; slot: MsgstrSlot }

const KEYWORD_RE = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")\s*$/
const MSGSTR_INDEX_RE = /^msgstr\[(\d+)\]$/

/** Parse the file into entries, tracking which lines each msgstr value occupies. */
function parsePoEntries(content: string): PoEntry[] {
  const lines = content.split("\n")
  const entries: PoEntry[] = []
  // Mutable cursor state. (Object properties rather than locals so the helper
  // mutations below don't fight TS control-flow narrowing.)
  const st: { cur: PoEntry | null; field: Field | null } = { cur: null, field: null }

  const open = (): PoEntry => {
    if (!st.cur) {
      st.cur = { references: [], msgstrSlots: [] }
      entries.push(st.cur)
    }
    return st.cur
  }
  const close = () => {
    st.cur = null
    st.field = null
  }

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()

    if (t === "") {
      close()
      continue
    }

    if (t.startsWith("#")) {
      // A comment after the msgstr block belongs to the NEXT entry.
      if (st.cur && st.cur.msgstrSlots.length > 0) close()
      const e = open()
      if (t.startsWith("#:")) {
        const refs = t.slice(2).trim().split(/\s+/).filter((r) => r.length > 0)
        e.references.push(...refs)
      }
      st.field = null
      continue
    }

    const kw = t.match(KEYWORD_RE)
    if (kw) {
      const keyword = kw[1]
      const value = parseQuotedPart(kw[2])
      // msgctxt / msgid start a NEW entry when the current one is already
      // complete (has msgstr) or already has a msgid (no blank-line separator).
      if (
        (keyword === "msgctxt" || keyword === "msgid") &&
        st.cur &&
        (st.cur.msgstrSlots.length > 0 || st.cur.msgid !== undefined)
      ) {
        close()
      }
      const e = open()
      if (keyword === "msgctxt") {
        e.msgctxt = value
        st.field = { kind: "msgctxt" }
      } else if (keyword === "msgid") {
        e.msgid = value
        st.field = { kind: "msgid" }
      } else if (keyword === "msgid_plural") {
        e.msgidPlural = value
        st.field = { kind: "msgid_plural" }
      } else {
        const idxMatch = keyword.match(MSGSTR_INDEX_RE)
        const slot: MsgstrSlot = {
          index: idxMatch ? Number(idxMatch[1]) : null,
          value,
          lineStart: i,
          lineEnd: i,
        }
        e.msgstrSlots.push(slot)
        st.field = { kind: "msgstr", slot }
      }
      continue
    }

    if (t.startsWith('"') && st.cur && st.field) {
      // Continuation line: adjacent quoted strings concatenate.
      const value = parseQuotedPart(t)
      const f = st.field
      if (f.kind === "msgstr") {
        f.slot.value += value
        f.slot.lineEnd = i
      } else if (f.kind === "msgctxt") {
        st.cur.msgctxt = (st.cur.msgctxt ?? "") + value
      } else if (f.kind === "msgid") {
        st.cur.msgid = (st.cur.msgid ?? "") + value
      } else {
        st.cur.msgidPlural = (st.cur.msgidPlural ?? "") + value
      }
      continue
    }
    // Unknown line: ignore for parsing (passes through untouched on export).
  }

  return entries.filter((e) => e.msgid !== undefined)
}

/** Skip the header entry (msgid ""). */
function isHeader(e: PoEntry): boolean {
  return e.msgid === ""
}

/** Plural slots (msgstr[N]) in file order; empty for a plural entry with no msgstr[N] lines. */
function pluralSlots(e: PoEntry): MsgstrSlot[] {
  return e.msgstrSlots.filter((s) => s.index !== null)
}

// ─── import ──────────────────────────────────────────────────────────────────

export function extractPoStrings(content: string): TranslatableString[] {
  const results: TranslatableString[] = []

  for (const e of parsePoEntries(content)) {
    if (isHeader(e)) continue
    const msgid = e.msgid ?? ""
    const context = e.msgctxt ?? e.references[0] ?? msgid

    if (e.msgidPlural !== undefined) {
      const slots = pluralSlots(e)
      const indices = slots.length > 0 ? slots.map((s) => s.index as number) : [0, 1]
      for (let k = 0; k < indices.length; k++) {
        const n = indices[k]
        results.push({
          id: uuid(),
          original: n === 0 ? msgid : e.msgidPlural,
          translated: slots[k]?.value ?? "",
          context,
          group: `${msgid}#${n}`,
          type: "text",
          metadata: {
            po: {
              ...(e.msgctxt !== undefined ? { msgctxt: e.msgctxt } : {}),
              ...(e.references[0] ? { sourceReference: e.references[0] } : {}),
            },
          },
        })
      }
    } else {
      results.push({
        id: uuid(),
        original: msgid,
        translated: e.msgstrSlots[0]?.value ?? "",
        context,
        group: e.msgctxt !== undefined ? `${msgid}\u0004${e.msgctxt}` : msgid,
        type: "text",
        metadata: {
          po: {
            ...(e.msgctxt !== undefined ? { msgctxt: e.msgctxt } : {}),
            ...(e.references[0] ? { sourceReference: e.references[0] } : {}),
          },
        },
      })
    }
  }

  return results
}

// ─── export ──────────────────────────────────────────────────────────────────

/**
 * Rebuild the original PO text, substituting msgstr values from `cells`
 * (matched positionally: Nth extracted string ↔ Nth cell). Everything else —
 * header entry, comments, flags, msgid/msgctxt lines — passes through
 * unchanged. A cell with an empty `translated` keeps the original msgstr
 * (which stays empty if it was empty — msgid is never copied in).
 */
export function exportPo(originalContent: string, cells: CellData[]): Blob {
  const lines = originalContent.split("\n")
  const entries = parsePoEntries(originalContent)

  /** lineStart → replacement keyword line (only when the cell has a non-empty translation). */
  const replaceAt = new Map<number, string>()
  /** Continuation lines of a replaced multi-line msgstr — dropped (value collapses to one line). */
  const dropLines = new Set<number>()
  let cellIdx = 0

  const applySlot = (slot: MsgstrSlot, cell: CellData | undefined) => {
    const translated = cell?.translated ?? ""
    if (translated === "") return // fallback: keep the original msgstr lines verbatim
    const keyword = slot.index === null ? "msgstr" : `msgstr[${slot.index}]`
    const crlf = lines[slot.lineStart]?.endsWith("\r") ? "\r" : ""
    replaceAt.set(slot.lineStart, `${keyword} "${escapePo(translated)}"${crlf}`)
    for (let l = slot.lineStart + 1; l <= slot.lineEnd; l++) dropLines.add(l)
  }

  for (const e of entries) {
    if (isHeader(e)) continue
    if (e.msgidPlural !== undefined) {
      const slots = pluralSlots(e)
      if (slots.length > 0) {
        for (const slot of slots) applySlot(slot, cells[cellIdx++])
      } else {
        cellIdx += 2 // extraction emitted virtual indices 0..1; no lines to rewrite
      }
    } else {
      const slot = e.msgstrSlots[0]
      const cell = cells[cellIdx++]
      if (slot) applySlot(slot, cell)
    }
  }

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (dropLines.has(i)) continue
    out.push(replaceAt.get(i) ?? lines[i])
  }

  return new Blob([out.join("\n")], { type: "text/x-gettext-translation;charset=utf-8" })
}
