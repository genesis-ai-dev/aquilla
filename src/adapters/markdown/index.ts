/**
 * Markdown adapter — the Phase 5 generality test.
 *
 * Structurally the opposite of IDML: no native ids, no package, line-based,
 * formatting expressed as inline punctuation. It shares *everything* above the
 * adapter boundary with IDML: the same reconciliation, ledger, planner, patch
 * engine, translators and feedback loop. Only extraction and rendering live
 * here.
 *
 * Translatable: headings, paragraphs, list items, blockquotes, table cells,
 * and front-matter `title`/`description`/`summary` values. Protected: fenced
 * and indented code, HTML blocks, link/image URLs, inline code, autolinks,
 * footnote references, inline HTML. Emphasis and link text become runs so a
 * translator may reorder them freely — Markdown can always express that.
 */
import { shortHash } from "../../core/hash.ts"
import { hasTranslatableText, parseTagged } from "../../core/tagged.ts"
import type { ContentGraph, ContentUnit, Diagnostic, ValidationResult } from "../../core/types.ts"
import type { ContentAdapter, RenderResult } from "../adapter.ts"

interface Line {
  readonly text: string
  readonly start: number
  readonly end: number
}

interface MdUnit {
  readonly unit: ContentUnit
  /** Byte range in the source to replace. */
  readonly start: number
  readonly end: number
  readonly runs: ReadonlyMap<number, { open: string; close: string }>
  readonly tokens: ReadonlyMap<number, string>
}

interface Extraction {
  readonly units: MdUnit[]
  readonly protectedBlocks: string[]
  readonly kinds: string[]
  readonly diagnostics: Diagnostic[]
}

const dec = new TextDecoder()
const enc = new TextEncoder()

const splitLines = (src: string): Line[] => {
  const out: Line[] = []
  let at = 0
  while (at <= src.length) {
    const nl = src.indexOf("\n", at)
    const end = nl < 0 ? src.length : nl
    const text = src.slice(at, end).replace(/\r$/, "")
    out.push({ text, start: at, end: at + text.length })
    if (nl < 0) break
    at = nl + 1
  }
  return out
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})/
const HEADING = /^(\s{0,3}#{1,6}\s+)(.*?)(\s+#+\s*)?$/
const LIST = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)(.*)$/
const QUOTE = /^(\s{0,3}>\s?)(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const HTML_BLOCK = /^\s{0,3}<(?:\/?[A-Za-z][A-Za-z0-9-]*|!--)/
const FRONT_KEYS = /^(\s*(?:title|description|summary|subtitle|excerpt)\s*:\s*)(["']?)(.*?)\2\s*$/

/** Parse inline markdown into tagged text plus the wrappers/tokens needed to rebuild it. */
export const inlineToTagged = (
  text: string,
): { tagged: string; runs: Map<number, { open: string; close: string }>; tokens: Map<number, string> } => {
  const runs = new Map<number, { open: string; close: string }>()
  const tokens = new Map<number, string>()
  const tok = (raw: string): string => {
    const id = tokens.size + 1
    tokens.set(id, raw)
    return `<x${id}/>`
  }
  const run = (open: string, inner: string, close: string): string => {
    const id = runs.size + 1
    runs.set(id, { open, close })
    return `<g${id}>${walk(inner)}</g${id}>`
  }
  const walk = (s: string): string => {
    let out = ""
    let i = 0
    while (i < s.length) {
      const rest = s.slice(i)
      let m: RegExpExecArray | null
      if ((m = /^\\[\\`*_{}[\]()#+\-.!|<>~]/.exec(rest))) {
        out += tok(m[0])
        i += m[0].length
        continue
      }
      if (rest[0] === "`" && (m = /^(`+)[\s\S]*?\1(?!`)/.exec(rest))) {
        out += tok(m[0])
        i += m[0].length
        continue
      }
      if ((m = /^!\[[^\]]*\]\([^)]*\)/.exec(rest))) {
        out += tok(m[0])
        i += m[0].length
        continue
      }
      if ((m = /^\[\^[^\]]+\]/.exec(rest))) {
        out += tok(m[0])
        i += m[0].length
        continue
      }
      if ((m = /^\[((?:[^\[\]]|\[[^\]]*\])+)\](\([^)]*\)|\[[^\]]*\])/.exec(rest))) {
        out += run("[", m[1]!, `]${m[2]}`)
        i += m[0].length
        continue
      }
      if ((m = /^<(?:https?:\/\/|mailto:)[^>\s]+>/.exec(rest)) || (m = /^<\/?[A-Za-z][^>]*>/.exec(rest))) {
        out += tok(m[0])
        i += m[0].length
        continue
      }
      if ((m = /^https?:\/\/[^\s)<>]+[^\s)<>.,;:!?'"]/.exec(rest))) {
        out += tok(m[0])
        i += m[0].length
        continue
      }
      if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
        out += run(m[1]!, m[2]!, m[1]!)
        i += m[0].length
        continue
      }
      if ((m = /^(~~)(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
        out += run("~~", m[2]!, "~~")
        i += m[0].length
        continue
      }
      const prev = i > 0 ? s[i - 1]! : " "
      if ((m = /^([*_])(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/u.exec(rest)) && (m[1] === "*" || !/[\p{L}\p{N}]/u.test(prev))) {
        out += run(m[1]!, m[2]!, m[1]!)
        i += m[0].length
        continue
      }
      out += s[i]
      i++
    }
    return out
  }
  return { tagged: walk(text), runs, tokens }
}

export const taggedToInline = (tagged: string, runs: ReadonlyMap<number, { open: string; close: string }>, tokens: ReadonlyMap<number, string>): string =>
  parseTagged(tagged)
    .map((p) => (p.kind === "text" ? p.text : p.kind === "open" ? (runs.get(p.id)?.open ?? "") : p.kind === "close" ? (runs.get(p.id)?.close ?? "") : (tokens.get(p.id) ?? "")))
    .join("")

const extract = (src: string): Extraction => {
  const lines = splitLines(src)
  const units: MdUnit[] = []
  const protectedBlocks: string[] = []
  const kinds: string[] = []
  const diagnostics: Diagnostic[] = []
  let block = 0
  const add = (kind: string, start: number, end: number, text: string, sub = ""): void => {
    kinds.push(kind)
    const effective =
      kind === "front-matter" ? { tagged: text, runs: new Map<number, { open: string; close: string }>(), tokens: new Map<number, string>() } : inlineToTagged(text)
    const plain = parseTagged(effective.tagged).map((p) => (p.kind === "text" ? p.text : "")).join("")
    if (!hasTranslatableText(plain)) return
    const ordinal = units.length
    units.push({
      unit: {
        logicalId: "",
        scope: "doc",
        structuralPath: `md#${block}${sub}`,
        ordinal,
        kind,
        tagged: effective.tagged,
        plain,
        contentHash: shortHash(effective.tagged),
      },
      start,
      end,
      runs: effective.runs,
      tokens: effective.tokens,
    })
  }
  let i = 0
  // Front matter.
  if (lines[0]?.text === "---") {
    let j = 1
    while (j < lines.length && lines[j]!.text !== "---" && lines[j]!.text !== "...") j++
    if (j < lines.length) {
      for (let k = 1; k < j; k++) {
        const l = lines[k]!
        const m = FRONT_KEYS.exec(l.text)
        if (m && m[3]) {
          const s = l.start + m[1]!.length + m[2]!.length
          add("front-matter", s, s + m[3].length, m[3], `.fm${k}`)
        }
      }
      protectedBlocks.push(lines.slice(0, j + 1).map((l) => (FRONT_KEYS.test(l.text) ? "<fm>" : l.text)).join("\n"))
      i = j + 1
      block++
    }
  }
  const isBlank = (l: Line | undefined): boolean => !l || l.text.trim() === ""
  while (i < lines.length) {
    const l = lines[i]!
    if (isBlank(l)) {
      i++
      continue
    }
    const fence = FENCE.exec(l.text)
    if (fence) {
      const marker = fence[2]!
      let j = i + 1
      while (j < lines.length && !lines[j]!.text.trimStart().startsWith(marker[0]!.repeat(marker.length))) j++
      protectedBlocks.push(lines.slice(i, Math.min(j + 1, lines.length)).map((x) => x.text).join("\n"))
      kinds.push("code")
      i = j + 1
      block++
      continue
    }
    if (/^( {4}|\t)/.test(l.text) && (i === 0 || isBlank(lines[i - 1]))) {
      let j = i
      while (j < lines.length && (/^( {4}|\t)/.test(lines[j]!.text) || isBlank(lines[j]))) j++
      protectedBlocks.push(lines.slice(i, j).map((x) => x.text).join("\n"))
      kinds.push("code")
      i = j
      block++
      continue
    }
    if (HTML_BLOCK.test(l.text)) {
      let j = i
      while (j < lines.length && !isBlank(lines[j])) j++
      protectedBlocks.push(lines.slice(i, j).map((x) => x.text).join("\n"))
      kinds.push("html")
      i = j
      block++
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l.text)) {
      kinds.push("rule")
      i++
      block++
      continue
    }
    const h = HEADING.exec(l.text)
    if (h) {
      const s = l.start + h[1]!.length
      add("heading", s, s + h[2]!.length, h[2]!)
      i++
      block++
      continue
    }
    if (l.text.trimStart().startsWith("|") && lines[i + 1] && TABLE_SEP.test(lines[i + 1]!.text)) {
      let j = i
      let row = 0
      while (j < lines.length && lines[j]!.text.trimStart().startsWith("|")) {
        const line = lines[j]!
        if (!TABLE_SEP.test(line.text)) {
          // Split on unescaped pipes, keeping offsets.
          let cell = 0
          let k = line.text.indexOf("|") + 1
          while (k < line.text.length) {
            let e = k
            while (e < line.text.length && !(line.text[e] === "|" && line.text[e - 1] !== "\\")) e++
            const raw = line.text.slice(k, e)
            const lead = raw.length - raw.trimStart().length
            const content = raw.trim()
            if (e >= line.text.length && content === "") break
            if (content) add("table-cell", line.start + k + lead, line.start + k + lead + content.length, content, `.r${row}c${cell}`)
            cell++
            k = e + 1
          }
        }
        row++
        j++
      }
      kinds.push("table")
      i = j
      block++
      continue
    }
    const li = LIST.exec(l.text)
    if (li) {
      const indent = li[1]!.length
      let j = i + 1
      while (j < lines.length && !isBlank(lines[j]) && !LIST.test(lines[j]!.text) && /^\s+/.test(lines[j]!.text) && lines[j]!.text.search(/\S/) >= Math.min(indent, 2)) j++
      const text = [li[2]!, ...lines.slice(i + 1, j).map((x) => x.text.trim())].join(" ")
      const s = l.start + indent
      add("list-item", s, lines[j - 1]!.end, text)
      i = j
      block++
      continue
    }
    const q = QUOTE.exec(l.text)
    if (q) {
      let j = i + 1
      while (j < lines.length && QUOTE.test(lines[j]!.text) && QUOTE.exec(lines[j]!.text)![2]!.trim() !== "") j++
      const text = lines.slice(i, j).map((x) => QUOTE.exec(x.text)![2]!.trim()).join(" ")
      const s = l.start + q[1]!.length
      add("blockquote", s, lines[j - 1]!.end, text)
      i = j
      block++
      continue
    }
    // Paragraph: until blank or another block start.
    let j = i + 1
    while (
      j < lines.length &&
      !isBlank(lines[j]) &&
      !FENCE.test(lines[j]!.text) &&
      !HEADING.test(lines[j]!.text) &&
      !LIST.test(lines[j]!.text) &&
      !QUOTE.test(lines[j]!.text) &&
      !HTML_BLOCK.test(lines[j]!.text)
    ) j++
    const indent = l.text.length - l.text.trimStart().length
    const text = lines.slice(i, j).map((x) => x.text.trim()).join(" ")
    add("paragraph", l.start + indent, lines[j - 1]!.end, text)
    i = j
    block++
  }
  return { units, protectedBlocks, kinds, diagnostics }
}

export const markdownAdapter: ContentAdapter = {
  format: "markdown",
  extensions: [".md", ".markdown", ".mdx"],

  extract(bytes: Uint8Array, docId: string): ContentGraph {
    const x = extract(dec.decode(bytes))
    return { docId, format: "markdown", revision: shortHash(bytes), units: x.units.map((u) => u.unit), diagnostics: x.diagnostics }
  },

  render(source: Uint8Array, translations: ReadonlyMap<string, string>): RenderResult {
    const src = dec.decode(source)
    const x = extract(src)
    const edits: Array<{ start: number; end: number; text: string }> = []
    for (const u of x.units) {
      const t = translations.get(u.unit.structuralPath)
      if (t === undefined) continue
      let text = u.unit.kind === "front-matter" ? parseTagged(t).map((p) => (p.kind === "text" ? p.text : "")).join("") : taggedToInline(t, u.runs, u.tokens)
      if (u.unit.kind === "table-cell") text = text.replace(/(?<!\\)\|/g, "\\|")
      if (u.unit.kind === "front-matter" && /[:#]/.test(text) && !/^["']/.test(text)) text = JSON.stringify(text)
      text = text.replace(/\n+/g, " ")
      edits.push({ start: u.start, end: u.end, text })
    }
    edits.sort((a, b) => b.start - a.start)
    let out = src
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
    return { bytes: out === src ? source : enc.encode(out), diagnostics: [] }
  },

  validate(source: Uint8Array, output: Uint8Array): ValidationResult {
    const s = extract(dec.decode(source))
    const o = extract(dec.decode(output))
    const diagnostics: Diagnostic[] = []
    if (s.protectedBlocks.join("\u0000") !== o.protectedBlocks.join("\u0000")) {
      diagnostics.push({ code: "PROTECTED_BLOCK_CHANGED", severity: "error", message: "code, HTML or front-matter blocks differ from the source" })
    }
    if (s.kinds.join(",") !== o.kinds.join(",")) {
      diagnostics.push({ code: "STRUCTURE_CHANGED", severity: "error", message: `block structure changed: ${s.kinds.length} blocks in source, ${o.kinds.length} in output` })
    }
    if (s.units.length !== o.units.length) {
      diagnostics.push({ code: "UNIT_COUNT_CHANGED", severity: "warning", message: `${s.units.length} translatable units in source, ${o.units.length} in output` })
    }
    return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics }
  },
}
