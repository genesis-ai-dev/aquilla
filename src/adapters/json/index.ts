/**
 * JSON string-resource adapter (`*.i18n.json`, `*.strings.json`) — the third
 * format, chosen because it is the opposite of Markdown: every unit has a
 * perfect native anchor (its key path), so reconciliation runs almost
 * entirely through pass 1. Same core, no format-specific sync logic.
 *
 * Placeholders are protected: ICU/i18next `{name}` and `{{name}}`, printf
 * `%s` `%1$d`, and numbered React tags `<0>…</0>` (rendered as runs).
 * Output keeps the source file's exact formatting — only string values change.
 */
import { shortHash } from "../../core/hash.ts"
import { hasTranslatableText, parseTagged } from "../../core/tagged.ts"
import type { ContentGraph, ContentUnit, Diagnostic, ValidationResult } from "../../core/types.ts"
import type { ContentAdapter, RenderResult } from "../adapter.ts"

const dec = new TextDecoder()
const enc = new TextEncoder()

interface StringValue {
  readonly path: string
  readonly start: number
  readonly end: number
  readonly value: string
}

/** Scan JSON, returning every string *value* with its key path and raw offsets (quotes excluded). */
export const scanJson = (src: string): StringValue[] => {
  const out: StringValue[] = []
  let i = 0
  const ws = (): void => {
    while (i < src.length && /\s/.test(src[i]!)) i++
  }
  const str = (): { value: string; start: number; end: number } => {
    if (src[i] !== '"') throw new Error(`expected string at ${i}`)
    const start = i + 1
    i++
    while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1
    const end = i
    i++
    return { value: JSON.parse(src.slice(start - 1, end + 1)) as string, start, end }
  }
  const value = (path: string): void => {
    ws()
    const c = src[i]
    if (c === "{") {
      i++
      ws()
      if (src[i] === "}") {
        i++
        return
      }
      for (;;) {
        ws()
        const k = str().value
        ws()
        if (src[i] !== ":") throw new Error(`expected ':' at ${i}`)
        i++
        value(path ? `${path}.${k}` : k)
        ws()
        if (src[i] === ",") {
          i++
          continue
        }
        if (src[i] === "}") {
          i++
          return
        }
        throw new Error(`expected ',' or '}' at ${i}`)
      }
    }
    if (c === "[") {
      i++
      ws()
      if (src[i] === "]") {
        i++
        return
      }
      let n = 0
      for (;;) {
        value(`${path}[${n++}]`)
        ws()
        if (src[i] === ",") {
          i++
          continue
        }
        if (src[i] === "]") {
          i++
          return
        }
        throw new Error(`expected ',' or ']' at ${i}`)
      }
    }
    if (c === '"') {
      const s = str()
      out.push({ path, ...s })
      return
    }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i))
    if (!m) throw new Error(`unexpected '${c}' at ${i}`)
    i += m[0].length
  }
  value("")
  ws()
  if (i < src.length) throw new Error(`trailing content at ${i}`)
  return out
}

const PLACEHOLDER = /\{\{[^}]+\}\}|\{[A-Za-z0-9_.]+(?:,[^{}]*)?\}|%(?:\d+\$)?[sdif@]|<\/?\d+\s*\/?>/g

const toTagged = (value: string): { tagged: string; tokens: Map<number, string>; runs: Map<number, { open: string; close: string }> } => {
  const tokens = new Map<number, string>()
  const runs = new Map<number, { open: string; close: string }>()
  let tagged = ""
  let last = 0
  const openTags: Array<{ n: string; g: number }> = []
  for (const m of value.matchAll(PLACEHOLDER)) {
    tagged += value.slice(last, m.index)
    last = m.index + m[0].length
    const tag = /^<(\/?)(\d+)\s*(\/?)>$/.exec(m[0])
    if (tag && !tag[3]) {
      if (!tag[1]) {
        const g = runs.size + 1
        runs.set(g, { open: m[0], close: `</${tag[2]}>` })
        openTags.push({ n: tag[2]!, g })
        tagged += `<g${g}>`
      } else {
        const at = openTags.map((o) => o.n).lastIndexOf(tag[2]!)
        if (at >= 0) {
          tagged += `</g${openTags[at]!.g}>`
          openTags.splice(at, 1)
        } else {
          const id = tokens.size + 1
          tokens.set(id, m[0])
          tagged += `<x${id}/>`
        }
      }
      continue
    }
    const id = tokens.size + 1
    tokens.set(id, m[0])
    tagged += `<x${id}/>`
  }
  tagged += value.slice(last)
  for (const o of openTags.reverse()) tagged += `</g${o.g}>`
  return { tagged, tokens, runs }
}

const fromTagged = (tagged: string, tokens: ReadonlyMap<number, string>, runs: ReadonlyMap<number, { open: string; close: string }>): string =>
  parseTagged(tagged)
    .map((p) => (p.kind === "text" ? p.text : p.kind === "token" ? (tokens.get(p.id) ?? "") : p.kind === "open" ? (runs.get(p.id)?.open ?? "") : (runs.get(p.id)?.close ?? "")))
    .join("")

const units = (src: string): Array<{ unit: ContentUnit; sv: StringValue; tokens: Map<number, string>; runs: Map<number, { open: string; close: string }> }> =>
  scanJson(src).flatMap((sv, k) => {
    const { tagged, tokens, runs } = toTagged(sv.value)
    const plain = parseTagged(tagged).map((p) => (p.kind === "text" ? p.text : "")).join("")
    if (!hasTranslatableText(plain) || sv.path.split(".").at(-1)?.startsWith("$")) return []
    const unit: ContentUnit = {
      logicalId: "",
      scope: "json",
      nativeAnchor: `key:${sv.path}`,
      structuralPath: `json#${sv.path}`,
      ordinal: k,
      kind: "string",
      tagged,
      plain,
      contentHash: shortHash(tagged),
    }
    return [{ unit, sv, tokens, runs }]
  })

export const jsonAdapter: ContentAdapter = {
  format: "json",
  extensions: [".i18n.json", ".strings.json"],

  extract(bytes: Uint8Array, docId: string): ContentGraph {
    return { docId, format: "json", revision: shortHash(bytes), units: units(dec.decode(bytes)).map((u) => u.unit), diagnostics: [] }
  },

  render(source: Uint8Array, translations: ReadonlyMap<string, string>): RenderResult {
    const src = dec.decode(source)
    let out = src
    for (const u of units(src).reverse()) {
      const t = translations.get(u.unit.structuralPath)
      if (t === undefined) continue
      const raw = JSON.stringify(fromTagged(t, u.tokens, u.runs)).slice(1, -1)
      out = out.slice(0, u.sv.start) + raw + out.slice(u.sv.end)
    }
    return { bytes: out === src ? source : enc.encode(out), diagnostics: [] }
  },

  validate(source: Uint8Array, output: Uint8Array): ValidationResult {
    const diagnostics: Diagnostic[] = []
    try {
      const s = scanJson(dec.decode(source)).map((x) => x.path)
      const o = scanJson(dec.decode(output)).map((x) => x.path)
      if (s.join("\n") !== o.join("\n")) diagnostics.push({ code: "KEYS_CHANGED", severity: "error", message: "key structure differs from the source" })
      JSON.parse(dec.decode(output))
    } catch (e) {
      diagnostics.push({ code: "INVALID_JSON", severity: "error", message: (e as Error).message })
    }
    return { ok: diagnostics.length === 0, diagnostics }
  },
}
