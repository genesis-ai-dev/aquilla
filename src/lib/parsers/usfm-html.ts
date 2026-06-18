// USFM verse-span ⇄ HTML round-trip mapper.
//
// The lossless side-car (usfm-lossless.ts) guarantees byte-identity for
// UNEDITED content: export just passes the original bytes through. The gap is
// EDITED verses — a translator who replaces a verse with plain prose silently
// loses everything that lived inside the verse span: footnotes (\f…\f*),
// cross-references (\x…\x*), inline character styling (\nd, \wj, \add, \bd…),
// and intra-verse line structure (\q1, \p, \li…).
//
// This module mirrors the codex-editor extension's approach
// (importers/usfm/usfmInlineMapper.ts): keep that structure INSIDE the editable
// cell, encoded as HTML, so it rides along through an edit and reconstructs on
// export. The conventions match codex-editor so the two stay interoperable:
//
//   • Inline character markers → semantic HTML carrying a data-usfm attribute:
//        \bd x\bd*   → <strong data-usfm="bd">x</strong>
//        \it x\it*   → <em data-usfm="it">x</em>
//        \nd x\nd*   → <span data-usfm="nd">x</span>
//     The reverse reads data-usfm first, then falls back to the semantic tag,
//     so a rich-text editor that strips data-* attributes still round-trips the
//     common emphasis markers.
//
//   • Footnotes / cross-references → a single <sup> token that carries the note
//     body verbatim in data-usfm-body, with the caller as visible text:
//        \f + \fr 1:1 \ft Note.\f*
//          → <sup data-usfm="f" data-usfm-body=" + \fr 1:1 \ft Note.">+</sup>
//     The body is opaque to the translator (it isn't editable prose) and is
//     re-emitted byte-for-byte on export.
//
//   • Intra-verse line-start markers (paragraph/poetry/list) → <br>:
//        \q1 line   → <br data-usfm="q1">line
//
// Round-trip contract (verified in usfm-html.test.ts):
//     htmlSpanToUsfm(usfmSpanToHtml(x)) reproduces x for the supported marker
//     set, modulo whitespace normalization around line-start markers (one space
//     after the marker). Whitespace normalization only ever affects EDITED
//     verses — unedited verses still export byte-identically from the side-car.
//
// DOM-free by design: htmlSpanToUsfm runs in the Cloudflare Worker export route
// where there is no DOMParser, so the reverse is a small tag tokenizer.

/** Inline character markers (paired: \x … \x*). Maps the marker name to the
 *  HTML tag used; absent ⇒ <span>. data-usfm is always emitted so the exact
 *  marker survives even when the tag is generic. */
const INLINE_TAG: Record<string, "strong" | "em" | "sup" | "span"> = {
  bd: "strong",
  it: "em",
  em: "em",
  bdit: "strong",
  sup: "sup",
  // Everything below renders as a styled <span> but keeps its marker via data-usfm.
  nd: "span", wj: "span", add: "span", sc: "span", tl: "span", qs: "span",
  qac: "span", k: "span", w: "span", pn: "span", png: "span", addpn: "span",
  ord: "span", sig: "span", lit: "span", dc: "span", bk: "span", pro: "span",
  rb: "span", fr: "span", fq: "span", fqa: "span", fk: "span", fl: "span",
  fv: "span", fw: "span",
}

/** Note containers (paired): footnote, endnote, cross-reference. Their inner
 *  body is preserved verbatim and never exposed as editable prose. */
const NOTE_MARKERS = new Set(["f", "fe", "x", "ef", "ex"])

/** Line-start structural markers that legitimately live INSIDE a verse span
 *  (paragraph / poetry / list / break). They are unpaired; each becomes a
 *  <br data-usfm="…">. Distinct from verse-terminating markers, which never
 *  appear inside a span (the lossless parser stops the span at those). */
const BREAK_MARKERS = new Set([
  "p", "m", "nb", "pmo", "pm", "pmc", "pmr", "pi", "pi1", "pi2", "pi3",
  "pc", "pr", "cls", "po", "lh", "lf",
  "q", "q1", "q2", "q3", "q4", "qc", "qr", "qd",
  "qm", "qm1", "qm2", "qm3",
  "li", "li1", "li2", "li3", "li4",
  "lim", "lim1", "lim2", "lim3", "lim4",
  "b", "ph", "ph1", "ph2", "ph3",
])

const NAMED_ENTITY: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ",
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function unescapeHtml(s: string): string {
  return s.replace(/&(#?\w+);/g, (m, ent: string) =>
    Object.prototype.hasOwnProperty.call(NAMED_ENTITY, ent) ? NAMED_ENTITY[ent] : m,
  )
}

// Matches a USFM marker: optional nesting "+", a name, an optional trailing "*"
// for an end marker. Group 1 = "+"?, group 2 = name, group 3 = "*"?.
const MARKER_RE = /\\(\+?)([a-z]+\d*)(\*?)/g

/** Convert a single verse/heading USFM span to HTML. The input is the text the
 *  lossless parser extracts for a verse (everything after `\v N `, up to the
 *  next verse-terminating marker), which may contain inline markers, notes and
 *  intra-verse breaks. */
export function usfmSpanToHtml(span: string): string {
  let out = ""
  // Stack of open inline tags so we can close them in order.
  const stack: { name: string; tag: string }[] = []
  let i = 0
  MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARKER_RE.exec(span)) !== null) {
    // Emit text before this marker.
    if (m.index > i) out += escapeHtml(span.slice(i, m.index))
    const name = m[2]
    const isEnd = m[3] === "*"
    const markerEnd = m.index + m[0].length

    if (isEnd) {
      // Close the matching inline tag if it's on top of the stack.
      const top = stack[stack.length - 1]
      if (top && top.name === name) {
        out += `</${top.tag}>`
        stack.pop()
      }
      // A stray/unmatched end marker is dropped from HTML; the side-car still
      // holds the truth for unedited verses, and edited verses rarely contain
      // orphan end markers.
      i = markerEnd
      continue
    }

    if (NOTE_MARKERS.has(name)) {
      // Capture the note body up to the matching end marker (\f*, \x*, …).
      const closeRe = new RegExp(`\\\\${name}\\*`, "g")
      closeRe.lastIndex = markerEnd
      const cm = closeRe.exec(span)
      const bodyEnd = cm ? cm.index : span.length
      const body = span.slice(markerEnd, bodyEnd)
      // Caller = first whitespace-delimited token of the body (e.g. "+", "-", "a").
      const caller = body.trim().split(/\s+/)[0] ?? ""
      out += `<sup data-usfm="${name}" data-usfm-body="${escapeHtml(body)}">${escapeHtml(caller)}</sup>`
      i = cm ? cm.index + cm[0].length : span.length
      MARKER_RE.lastIndex = i
      continue
    }

    if (BREAK_MARKERS.has(name)) {
      // Intra-verse paragraph/poetry/list break. Drop trailing whitespace
      // already emitted (the line's terminating newline) and swallow a single
      // following separator space so the <br> sits flush; it carries the marker
      // for exact reconstruction.
      out = out.replace(/\s+$/, "")
      out += `<br data-usfm="${name}">`
      let j = markerEnd
      if (span[j] === " " || span[j] === "\t") j++
      i = j
      MARKER_RE.lastIndex = i
      continue
    }

    // Inline character marker (paired). Open a tag; swallow one separator space.
    const tag = INLINE_TAG[name] ?? "span"
    out += `<${tag} data-usfm="${name}">`
    stack.push({ name, tag })
    let j = markerEnd
    if (span[j] === " ") j++
    i = j
    MARKER_RE.lastIndex = i
  }
  if (i < span.length) out += escapeHtml(span.slice(i))
  // Close any inline tags left open (defensive — well-formed USFM closes them).
  for (let k = stack.length - 1; k >= 0; k--) out += `</${stack[k].tag}>`
  // Normalize residual newlines to spaces: real line structure is carried by
  // <br>, and a literal newline inside an HTML cell is just whitespace.
  return out.replace(/\r?\n/g, " ")
}

// HTML token stream for the DOM-free reverse.
type HtmlToken =
  | { kind: "open"; tag: string; attrs: Record<string, string>; selfClose: boolean }
  | { kind: "close"; tag: string }
  | { kind: "text"; text: string }

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>/g
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g

function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > last) tokens.push({ kind: "text", text: html.slice(last, m.index) })
    const closing = m[1] === "/"
    const tag = m[2].toLowerCase()
    if (closing) {
      tokens.push({ kind: "close", tag })
    } else {
      const attrs: Record<string, string> = {}
      let a: RegExpExecArray | null
      ATTR_RE.lastIndex = 0
      while ((a = ATTR_RE.exec(m[3])) !== null) attrs[a[1].toLowerCase()] = a[2]
      tokens.push({ kind: "open", tag, attrs, selfClose: m[4] === "/" || tag === "br" })
    }
    last = m.index + m[0].length
  }
  if (last < html.length) tokens.push({ kind: "text", text: html.slice(last) })
  return tokens
}

/** Recover the USFM marker name an inline tag represents: data-usfm wins, then
 *  the semantic tag name (so attribute-stripping editors still round-trip
 *  emphasis). Returns null for transparent container tags (<p>, <div>). */
function inlineMarkerFor(tag: string, attrs: Record<string, string>): string | null {
  const dataUsfm = attrs["data-usfm"]
  if (dataUsfm) return dataUsfm
  switch (tag) {
    case "strong":
    case "b":
      return "bd"
    case "em":
    case "i":
      return "it"
    case "sup":
      return "sup"
    default:
      return null
  }
}

/** Convert verse-span HTML (as produced by usfmSpanToHtml, possibly re-wrapped
 *  by a rich-text editor) back to a USFM verse span. Inverse of usfmSpanToHtml
 *  for the supported marker set. */
export function htmlSpanToUsfm(html: string): string {
  const tokens = tokenizeHtml(html)
  let out = ""
  // Stack of inline marker names whose end markers we still owe.
  const stack: string[] = []
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind === "text") {
      out += unescapeHtml(t.text)
      continue
    }
    if (t.kind === "open") {
      if (t.tag === "br") {
        const name = t.attrs["data-usfm"] || "p"
        out += `\n\\${name} `
        continue
      }
      if (t.attrs["data-usfm-footnote"] !== undefined) {
        // codex-web's TipTap footnote node (UsfmFootnote) stores the COMPLETE
        // raw `\f…\f*` in data-usfm-footnote. Emit it verbatim and skip the
        // node's visible label so a footnote the translator KEPT round-trips.
        out += unescapeHtml(t.attrs["data-usfm-footnote"])
        if (!t.selfClose) {
          const tag = t.tag
          let depth = 1
          while (idx + 1 < tokens.length && depth > 0) {
            idx++
            const inner = tokens[idx]
            if (inner.kind === "open" && inner.tag === tag && !inner.selfClose) depth++
            else if (inner.kind === "close" && inner.tag === tag) depth--
          }
        }
        continue
      }
      if (t.tag === "sup" && t.attrs["data-usfm-body"] !== undefined) {
        const name = t.attrs["data-usfm"] || "f"
        out += `\\${name}${unescapeHtml(t.attrs["data-usfm-body"])}\\${name}*`
        // Skip the visible caller text up to the matching </sup>. Stop AT the
        // close token (the outer for-loop's idx++ then steps past it) so any
        // text following </sup> is not swallowed.
        let depth = 1
        while (idx + 1 < tokens.length && depth > 0) {
          idx++
          const inner = tokens[idx]
          if (inner.kind === "open" && inner.tag === "sup" && !inner.selfClose) depth++
          else if (inner.kind === "close" && inner.tag === "sup") depth--
        }
        continue
      }
      // Transparent containers contribute no marker (paragraph structure for
      // unedited verses lives in the side-car; intra-verse breaks use <br>).
      if (t.tag === "p" || t.tag === "div" || t.tag === "span") {
        const marker = inlineMarkerFor(t.tag, t.attrs)
        if (marker) {
          out += `\\${marker} `
          stack.push(marker)
        } else {
          stack.push("") // transparent: remember to pop on close, emit nothing
        }
        continue
      }
      const marker = inlineMarkerFor(t.tag, t.attrs)
      if (marker) {
        out += `\\${marker} `
        stack.push(marker)
      } else {
        stack.push("")
      }
      continue
    }
    // close tag
    const marker = stack.pop()
    if (marker) out += `\\${marker}*`
  }
  return out
}

// ── Per-block export support ─────────────────────────────────────────────────
//
// The export re-inserts translated text into the ORIGINAL file's existing
// blocks: block scaffolding (paragraph/poetry/list markers + whitespace) stays
// byte-for-byte, and the INLINE content of each block (text + character styles +
// footnotes/cross-refs) is driven by the TARGET. So a style or note the
// translation dropped is absent from the export (and flagged by the
// usfm-marker-integrity rule), while a verse number, \q1, or indentation is
// never disturbed.
//
//   • `usfmSpanBlocks` — the source's inline-content regions, split at BLOCK
//     markers only (notes/inline styles stay inside a region).
//   • `extractTargetBlocks` — the translation's blocks, split at <br>/<p>/<div>.
// When the block counts line up, each target block's inline USFM replaces the
// source region; otherwise the caller falls back to whole-span reconstruction.

export interface UsfmSpanBlock {
  /** Offset of the trimmed inline region within the span. */
  start: number
  /** End offset (exclusive) of the trimmed inline region within the span. */
  end: number
}

/** Inline-content regions of a verse span, split at BLOCK markers (`\p`, `\q1`,
 *  `\li`, `\b`…). Note bodies and inline character markers stay INSIDE a region
 *  (they are inline content, replaced from the target). Empty/whitespace-only
 *  regions are dropped; the block markers that bordered them are preserved as
 *  the verbatim separators between the regions that remain. */
export function usfmSpanBlocks(span: string): UsfmSpanBlock[] {
  const blocks: UsfmSpanBlock[] = []
  const pushRegion = (from: number, to: number) => {
    const raw = span.slice(from, to)
    const lead = raw.match(/^\s*/)![0].length
    const trail = raw.match(/\s*$/)![0].length
    const start = from + lead
    const end = to - trail
    if (end > start) blocks.push({ start, end })
  }
  let regionStart = 0
  MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MARKER_RE.exec(span)) !== null) {
    const name = m[2]
    const isEnd = m[3] === "*"
    const markerEnd = m.index + m[0].length
    if (!isEnd && NOTE_MARKERS.has(name)) {
      // Skip the note body so a stray block-marker name inside a note doesn't
      // split a block; the note stays part of the surrounding inline region.
      const closeRe = new RegExp(`\\\\${name}\\*`, "g")
      closeRe.lastIndex = markerEnd
      const cm = closeRe.exec(span)
      MARKER_RE.lastIndex = cm ? cm.index + cm[0].length : span.length
      continue
    }
    if (!isEnd && BREAK_MARKERS.has(name)) {
      pushRegion(regionStart, m.index)
      regionStart = markerEnd
    }
  }
  pushRegion(regionStart, span.length)
  return blocks
}

/** Inline USFM for each block of a target cell's HTML — split at block
 *  boundaries (<br>, <p>, <div>), each segment converted via the caller's
 *  HTML→USFM step. Returns the raw inline-HTML segments (caller converts +
 *  trims + drops empties). */
export function extractTargetBlocks(html: string): string[] {
  return html.split(/<br\b[^>]*>|<\/?p\b[^>]*>|<\/?div\b[^>]*>/gi)
}

// ── Inline-marker integrity (source ⇄ target) ────────────────────────────────
//
// Block structure (verses, paragraphs, poetry) is owned by the side-car and
// reinserted on export, so it never needs the translator's cooperation. Inline
// styling is different: extracting a verse into an editable cell doesn't force
// the translator to keep the source's `\nd`/`\bd`/footnote markup. Rather than
// force it, we DETECT drift (the `usfm-marker-integrity` rule) and offer to
// restore the formatting ones. Footnotes/cross-refs can't be auto-created, so
// they are flagged only.

/** Inline markers found in an HTML cell value, split into character formatting
 *  vs notes (footnotes/cross-refs). Marker names repeat to form a multiset, so
 *  callers can detect "source has two \nd but target has one". */
export interface InlineMarkerSet {
  format: string[]
  note: string[]
}

const SEMANTIC_TAG_MARKER: Record<string, string> = {
  strong: "bd", b: "bd", em: "it", i: "it", sup: "sup",
}

/** Extract the inline markers present in an HTML cell value. Recognizes both the
 *  `data-usfm` attributes our mapper emits and the bare semantic tags a
 *  rich-text editor produces for bold/italic. */
export function inlineMarkersInHtml(html: string): InlineMarkerSet {
  const format: string[] = []
  const note: string[] = []
  if (!html) return { format, note }
  // data-usfm attributes (notes carry data-usfm-body too).
  for (const m of html.matchAll(/data-usfm="([^"]+)"/g)) {
    const name = m[1]
    if (NOTE_MARKERS.has(name)) note.push(name)
    else format.push(name)
  }
  // codex-web's TipTap footnote node carries the raw note in data-usfm-footnote
  // (not data-usfm); count each as a note — using the raw's leading marker name
  // — so a footnote the translator KEPT via the editor isn't mis-flagged as
  // dropped by the usfm-marker-integrity rule.
  for (const m of html.matchAll(/data-usfm-footnote="([^"]*)"/g)) {
    const nameMatch = m[1].match(/\\([a-z]+\d*)/)
    note.push(nameMatch && NOTE_MARKERS.has(nameMatch[1]) ? nameMatch[1] : "f")
  }
  // Bare semantic tags WITHOUT data-usfm (editor-produced emphasis). Skip note
  // <sup>s (they carry data-usfm-body) and anything already counted above.
  for (const m of html.matchAll(/<(strong|b|em|i|sup)\b([^>]*)>/gi)) {
    const attrs = m[2]
    if (/data-usfm\s*=/.test(attrs)) continue
    format.push(SEMANTIC_TAG_MARKER[m[1].toLowerCase()])
  }
  return { format, note }
}

function multisetMinus(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>()
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1)
  const out: string[] = []
  for (const x of a) {
    const c = counts.get(x) ?? 0
    if (c > 0) counts.set(x, c - 1)
    else out.push(x)
  }
  return out
}

export interface InlineMarkerDiff {
  /** Formatting markers in source but missing from target (auto-restorable). */
  missingFormat: string[]
  /** Notes in source but missing from target (flag only — not auto-creatable). */
  missingNote: string[]
}

/** Markers the source carries that the target dropped. Empty arrays ⇒ no drift. */
export function diffInlineMarkers(sourceHtml: string, targetHtml: string): InlineMarkerDiff {
  const s = inlineMarkersInHtml(sourceHtml)
  const t = inlineMarkersInHtml(targetHtml)
  return {
    missingFormat: multisetMinus(s.format, t.format),
    missingNote: multisetMinus(s.note, t.note),
  }
}

/** A formatted run extracted from source HTML: the marker + the text it wraps. */
interface FormatRun {
  name: string
  text: string
}

/** Pull `{ name, text }` for each character-formatting run in source HTML. Notes
 *  are skipped (their <sup> body is not translatable prose). */
function formatRuns(html: string): FormatRun[] {
  const runs: FormatRun[] = []
  // data-usfm spans/strong/em (not notes — those have data-usfm-body).
  const re = /<([a-z]+)\b([^>]*\bdata-usfm="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (/data-usfm-body/.test(m[2])) continue
    const name = m[3]
    if (NOTE_MARKERS.has(name)) continue
    runs.push({ name, text: stripTags(m[4]) })
  }
  // Bare semantic emphasis tags.
  const reSem = /<(strong|b|em|i)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  while ((m = reSem.exec(html)) !== null) {
    if (/data-usfm/.test(m[2])) continue
    runs.push({ name: SEMANTIC_TAG_MARKER[m[1].toLowerCase()], text: stripTags(m[3]) })
  }
  return runs
}

function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, ""))
}

const TAG_FOR_MARKER: Record<string, string> = { bd: "strong", it: "em", sup: "sup" }

/** Best-effort autofix: re-apply the source's character formatting to the
 *  target by wrapping the matching word(s) where they occur verbatim. Only
 *  formatting is restored — footnotes/cross-refs are never fabricated. Returns
 *  the new target HTML (unchanged if nothing could be safely restored). The
 *  result is always reviewed via a fix preview before it is committed. */
export function restoreFormattingToTarget(sourceHtml: string, targetHtml: string): string {
  let out = targetHtml
  for (const run of formatRuns(sourceHtml)) {
    const text = run.text.trim()
    if (!text) continue
    const tag = TAG_FOR_MARKER[run.name] ?? "span"
    const open = `<${tag} data-usfm="${run.name}">`
    const wrapped = `${open}${escapeHtml(text)}</${tag}>`
    if (out.includes(wrapped)) continue // already applied
    const needle = escapeHtml(text)
    // Wrap the first occurrence that is not already inside a data-usfm element.
    const idx = firstUnwrappedIndex(out, needle)
    if (idx < 0) continue
    out = out.slice(0, idx) + wrapped + out.slice(idx + needle.length)
  }
  return out
}

/** Index of the first occurrence of `needle` in `html` that is plain text (not
 *  inside any tag and not already wrapped in a data-usfm element). -1 if none. */
function firstUnwrappedIndex(html: string, needle: string): number {
  let from = 0
  for (;;) {
    const idx = html.indexOf(needle, from)
    if (idx < 0) return -1
    const before = html.slice(0, idx)
    const openTags = (before.match(/<[a-z]/gi) ?? []).length
    const closeTags = (before.match(/<\//g) ?? []).length
    // Equal counts ⇒ not currently inside an element; also ensure not mid-tag.
    const lastLt = before.lastIndexOf("<")
    const lastGt = before.lastIndexOf(">")
    const insideTag = lastLt > lastGt
    if (openTags === closeTags && !insideTag) return idx
    from = idx + 1
  }
}

/** Underline the source styling whose marker drifted from the target. Adds a
 *  `usfm-mismatch` class (and `data-usfm-mismatch`) to source elements whose
 *  marker is in `missing`, so the source render can underline them. Operates on
 *  the HTML the source already renders (`originalHtml`). */
export function markMismatchedSourceMarkers(sourceHtml: string, missing: string[]): string {
  if (missing.length === 0) return sourceHtml
  const want = new Set(missing)
  return sourceHtml.replace(
    /<([a-z]+)((?:\s+[^<>]*?)?)>/gi,
    (full, tag: string, attrs: string) => {
      const dm = attrs.match(/data-usfm="([^"]+)"/)
      const marker = dm ? dm[1] : SEMANTIC_TAG_MARKER[tag.toLowerCase()]
      if (!marker || !want.has(marker)) return full
      if (/class="/.test(attrs)) {
        return `<${tag}${attrs.replace(/class="([^"]*)"/, 'class="$1 usfm-mismatch"')} data-usfm-mismatch="${marker}">`
      }
      return `<${tag}${attrs} class="usfm-mismatch" data-usfm-mismatch="${marker}">`
    },
  )
}
