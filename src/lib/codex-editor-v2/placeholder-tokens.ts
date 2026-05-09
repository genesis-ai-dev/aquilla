/**
 * Plain text ↔ ProseMirror JSON for cell translation content.
 *
 * Persistence shape (in `cells.translation_text`): plain text with
 * placeholder tokens — `{tagId}` (atomic, e.g. footnote reference) and
 * `{tagId}content{/tagId}` (paired, e.g. style wrapper). The classification
 * comes from the per-cell `tag_dictionary` entry: `kind: "ph"` is atomic,
 * `kind: "style"` is paired. See DATA_PERSISTENCE_PLAN.md §6.
 *
 * Editor shape: ProseMirror JSON with two custom additions —
 *   - `phRef` atomic inline node, attrs `{ tagId }`
 *   - `phStyle` inline mark, attrs `{ tagId }`
 *
 * The parse/serialize functions are pure and live here so they can be
 * round-trip property-tested without booting an editor instance.
 *
 * Escaping: literal braces in user content are encoded as `\{` and `\}`
 * on the serialized side, so a translator who literally writes `{not a tag}`
 * doesn't have it eaten by the parser.
 */

export type TagKind = "style" | "ph"

export interface TagDictionaryEntry {
  kind: TagKind
  origin?: { format: string; marker: string }
  ref?: { cell_id: string }
  [key: string]: unknown
}

export type TagDictionary = Record<string, TagDictionaryEntry>

/* ──────────────────  ProseMirror JSON shapes  ────────────────── */

export interface PMTextNode {
  type: "text"
  text: string
  marks?: PMMark[]
}

export interface PMPhRefNode {
  type: "phRef"
  attrs: { tagId: string }
}

export type PMInline = PMTextNode | PMPhRefNode

export interface PMParagraph {
  type: "paragraph"
  content: PMInline[]
}

export interface PMDoc {
  type: "doc"
  content: PMParagraph[]
}

export interface PMMark {
  type: "phStyle"
  attrs: { tagId: string }
}

/* ──────────────────────────  parser  ──────────────────────────── */

const TOKEN_RE = /\{(\/?)([a-z][a-z0-9]*)\}/g
const ESCAPED_BRACE_RE = /\\([{}])/g

interface RawMatch {
  start: number
  end: number
  tagId: string
  closing: boolean
}

function findTokenMatches(text: string): RawMatch[] {
  const out: RawMatch[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0
    let backslashes = 0
    for (let i = start - 1; i >= 0 && text[i] === "\\"; i--) backslashes++
    if (backslashes % 2 === 1) continue
    out.push({
      start,
      end: start + m[0].length,
      tagId: m[2],
      closing: m[1] === "/",
    })
  }
  return out
}

export function parseTranslationText(
  text: string,
  dict: TagDictionary,
): PMDoc {
  if (!text) {
    return { type: "doc", content: [{ type: "paragraph", content: [] }] }
  }

  const matches = findTokenMatches(text)
  const accepted = new Set<number>()

  for (let i = 0; i < matches.length; i++) {
    const tok = matches[i]
    if (tok.closing) continue
    const entry = dict[tok.tagId]
    if (!entry) continue
    if (entry.kind === "ph") {
      accepted.add(i)
      continue
    }
    if (entry.kind === "style") {
      const closeIdx = matches.findIndex(
        (cand, j) => j > i && cand.closing && cand.tagId === tok.tagId,
      )
      if (closeIdx === -1) continue
      accepted.add(i)
      accepted.add(closeIdx)
    }
  }

  const inline: PMInline[] = []
  let cursor = 0
  let activeStyle: { tagId: string; chunks: PMTextNode[] } | null = null

  function emitLiteral(textChunk: string): void {
    if (!textChunk) return
    const decoded = textChunk.replace(ESCAPED_BRACE_RE, "$1")
    if (!decoded) return
    if (activeStyle) {
      activeStyle.chunks.push({
        type: "text",
        text: decoded,
        marks: [{ type: "phStyle", attrs: { tagId: activeStyle.tagId } }],
      })
    } else {
      inline.push({ type: "text", text: decoded })
    }
  }

  for (let i = 0; i < matches.length; i++) {
    if (!accepted.has(i)) continue
    const tok = matches[i]
    emitLiteral(text.slice(cursor, tok.start))
    cursor = tok.end
    const entry = dict[tok.tagId]!
    if (entry.kind === "ph") {
      if (activeStyle) {
        for (const ch of activeStyle.chunks) inline.push(ch)
        activeStyle.chunks = []
      }
      inline.push({ type: "phRef", attrs: { tagId: tok.tagId } })
      continue
    }
    if (tok.closing) {
      if (activeStyle && activeStyle.tagId === tok.tagId) {
        for (const ch of activeStyle.chunks) inline.push(ch)
        activeStyle = null
      }
    } else {
      activeStyle = { tagId: tok.tagId, chunks: [] }
    }
  }
  emitLiteral(text.slice(cursor))
  if (activeStyle) {
    for (const ch of activeStyle.chunks) inline.push(ch)
  }

  return {
    type: "doc",
    content: [{ type: "paragraph", content: mergeAdjacentText(inline) }],
  }
}

function mergeAdjacentText(inline: PMInline[]): PMInline[] {
  const out: PMInline[] = []
  for (const node of inline) {
    const last = out[out.length - 1]
    if (
      last &&
      last.type === "text" &&
      node.type === "text" &&
      sameMarks(last.marks, node.marks)
    ) {
      out[out.length - 1] = { ...last, text: last.text + node.text }
    } else {
      out.push(node)
    }
  }
  return out
}

function sameMarks(a?: PMMark[], b?: PMMark[]): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type || a[i].attrs.tagId !== b[i].attrs.tagId)
      return false
  }
  return true
}

/* ────────────────────────  serializer  ────────────────────────── */

export function serializeProseMirrorDoc(doc: PMDoc): string {
  const paras: string[] = []
  for (const p of doc.content) {
    paras.push(serializeParagraph(p))
  }
  return paras.join("\n\n")
}

function serializeParagraph(p: PMParagraph): string {
  const parts: string[] = []
  for (const node of p.content) {
    if (node.type === "phRef") {
      parts.push(`{${node.attrs.tagId}}`)
      continue
    }
    const escaped = node.text.replace(/([{}])/g, "\\$1")
    if (node.marks && node.marks.length > 0) {
      const tag = node.marks[0].attrs.tagId
      parts.push(`{${tag}}${escaped}{/${tag}}`)
    } else {
      parts.push(escaped)
    }
  }
  return parts.join("")
}
