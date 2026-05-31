// USX → USFM conversion.
//
// USX is the XML serialization of USFM that Paratext 9 uses internally and can
// export. It's isomorphic to USFM: every <para>/<char>/<note> `style` attribute
// IS a USFM marker name (so usfm-markers.ts classifies both). Rather than build
// a parallel USX pipeline, we convert USX→USFM and run the existing, proven
// USFM pipeline (lossless parser, tokenizer, conformance, export).
//
// Conversion is content-faithful, not byte-faithful — there is no original
// USFM to match. Verses land on their own lines (USFM convention); text-bearing
// blocks (\s, \mt, \h…) keep their text on the marker line; character markers
// and footnotes get their paired \x...\x* form.
//
// v1 import path: USX in → USFM → cells + side-car. (USX-native round-trip —
// keeping the original USX bytes as the export side-car — is a future step;
// for now an imported USX exports as USFM, which Paratext also reads.)

import { classifyMarker } from "./usfm-markers"

/** True if a USX <para> wraps verses (a paragraph marker) vs. carries its own
 *  text (a heading/title). Drives whether content goes on the marker line. */
function containsVerse(el: Element): boolean {
  return el.querySelector("verse") !== null
}

function emit(node: Node, out: string[]): void {
  // Text node
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = node.nodeValue ?? ""
    // Drop XML indentation: whitespace-only runs that span a line break are
    // pretty-printing, not content. Real inter-word/inter-element spaces don't
    // contain newlines, so they survive.
    if (text.trim() === "" && /\n/.test(text)) return
    out.push(text)
    return
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  const style = el.getAttribute("style") ?? ""

  switch (tag) {
    case "book": {
      const code = el.getAttribute("code") ?? ""
      const text = (el.textContent ?? "").trim()
      out.push(`\\${style || "id"} ${code}${text ? ` ${text}` : ""}\n`)
      return
    }
    case "chapter": {
      if (el.getAttribute("eid")) return // chapter-end milestone → drop
      out.push(`\n\\c ${el.getAttribute("number") ?? ""}\n`)
      return
    }
    case "verse": {
      if (el.getAttribute("eid")) return // verse-end milestone → drop
      out.push(`\n\\v ${el.getAttribute("number") ?? ""} `)
      return
    }
    case "para": {
      out.push(`\n\\${style}`)
      if (!containsVerse(el)) out.push(" ") // heading/title: text on this line
      for (const c of Array.from(el.childNodes)) emit(c, out)
      return
    }
    case "char": {
      // Footnote/xref interior markers (\fr, \ft, \fq, \xo, \xt…) are NOT
      // paired in USFM — they run until the next marker. Body character
      // markers (\nd, \wj, \add…) ARE paired (\nd…\nd*). The taxonomy knows
      // which; default to paired for unknown markers (safer for body chars).
      const paired = classifyMarker(style)?.paired !== false
      // Space-separate from preceding non-space content so consecutive note
      // markers read as "\fr 1:1 \ft text", not "\fr 1:1\ft text".
      const last = out.length ? out[out.length - 1] : ""
      if (last && !/\s$/.test(last)) out.push(" ")
      out.push(`\\${style} `)
      for (const c of Array.from(el.childNodes)) emit(c, out)
      if (paired) out.push(`\\${style}*`)
      return
    }
    case "note": {
      const caller = el.getAttribute("caller") ?? "+"
      out.push(`\\${style} ${caller} `)
      for (const c of Array.from(el.childNodes)) emit(c, out)
      out.push(`\\${style}*`)
      return
    }
    case "optbreak":
      out.push("//")
      return
    case "ms":
      return // standalone milestone — no textual content
    default:
      // Unknown wrapper (e.g. <usx>, <sidebar>, <table>) — recurse to keep text.
      for (const c of Array.from(el.childNodes)) emit(c, out)
      return
  }
}

/** Convert a USX document to equivalent USFM. Throws on malformed XML. */
export function usxToUsfm(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml")
  const err = doc.querySelector("parsererror")
  if (err) throw new Error(`USX parse error: ${err.textContent?.slice(0, 200) ?? "malformed XML"}`)
  const root = doc.querySelector("usx") ?? doc.documentElement
  if (!root) throw new Error("USX has no root element")

  const out: string[] = []
  for (const node of Array.from(root.childNodes)) emit(node, out)

  // Tidy: collapse marker-trailing spaces before newlines, drop leading
  // blank lines, ensure a single trailing newline.
  return (
    out
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "") + "\n"
  )
}

/** Detect a USX document (vs raw USFM) from its leading bytes. */
export function looksLikeUsx(content: string): boolean {
  const head = content.slice(0, 500)
  return /<usx\b/.test(head) || (/^\s*<\?xml/.test(head) && /<(book|para|chapter|verse)\b[^>]*\bstyle=/.test(head))
}
