/**
 * TMX 1.4b bilingual importer.
 *
 * Spec ref: https://www.gala-global.org/tmx-14b
 *
 * Structure:
 *   <tmx> → <header srclang="..."> + <body> → <tu> → <tuv xml:lang> → <seg>
 *
 * Language selection:
 *   1. Use <header srclang> as the source language key.
 *   2. If srclang is absent or "*all*", treat the first <tuv> language found
 *      in the first <tu> as source.
 *   3. The target is the first language that differs from source.
 *
 * SWARM-TODO(import): handle multiple target languages (e.g. multilingual TMX
 *   with 3+ tuv children). Currently only first non-source tuv is used.
 * SWARM-TODO(import): preserve <prop> and <note> metadata from <tu> as
 *   searchable context. Currently collapsed to the tu id or first prop value.
 */

import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { serializeInner, codeAwareTextContent } from "./xliff"

/** Round-trip metadata captured per <tu> on TMX import. */
export interface TmxSegmentMeta {
  tuid?: string
  srcLang: string
  tgtLang?: string
  /** Inner XML of the source <seg> with inline tags (bpt/ept/ph/it/hi) verbatim. */
  srcSegXml: string
  /** Inner XML of the target <seg>, when present. */
  tgtSegXml?: string
}

// ─── helpers ────────────────────────────────────────────────────────────────

function textContent(el: Element): string {
  return el.textContent ?? ""
}

function allByLocalName(root: Element, localName: string): Element[] {
  const out: Element[] = []
  function walk(el: Element) {
    if (el.localName === localName) out.push(el)
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(root)
  return out
}

/**
 * Get xml:lang from a <tuv> element. The attribute name is in the XML
 * namespace so we check both `xml:lang` and plain `lang` for robustness.
 */
function tuvLang(tuv: Element): string {
  return (
    tuv.getAttributeNS("http://www.w3.org/XML/1998/namespace", "lang") ||
    tuv.getAttribute("xml:lang") ||
    tuv.getAttribute("lang") ||
    ""
  ).toLowerCase()
}

// ─── entry point ────────────────────────────────────────────────────────────

/** Replace CDATA sections with XML-escaped equivalents for parser compatibility. */
function normalizeCdata(xml: string): string {
  return xml.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, (_match, content: string) => {
    return content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  })
}

/**
 * Parse a TMX 1.4b document and return one TranslatableString per <tu>.
 * Source/target language selection is described in the module header.
 *
 * Runs in the browser — uses the global `DOMParser`.
 */
export function parseTmx(xmlText: string): TranslatableString[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(normalizeCdata(xmlText), "application/xml")

  const parseError = doc.querySelector("parsererror")
  if (parseError) {
    throw new Error(`TMX parse error: ${parseError.textContent?.slice(0, 200)}`)
  }

  const root = doc.documentElement

  // ── determine source language ────────────────────────────────────────────
  const headerEl = Array.from(root.children).find((c) => c.localName === "header") ?? null
  let srclang = (
    headerEl?.getAttribute("srclang") ||
    headerEl?.getAttributeNS("http://www.w3.org/XML/1998/namespace", "lang") ||
    ""
  ).toLowerCase()

  if (srclang === "*all*") srclang = ""

  // If header doesn't give us a source lang, sniff from the first tu
  const bodyEl = Array.from(root.children).find((c) => c.localName === "body") ?? root
  const allTus = allByLocalName(bodyEl, "tu")

  if (!srclang && allTus.length > 0) {
    const firstTuvs = Array.from(allTus[0].children).filter((c) => c.localName === "tuv")
    if (firstTuvs.length > 0) {
      srclang = tuvLang(firstTuvs[0])
    }
  }

  const results: TranslatableString[] = []

  for (const tu of allTus) {
    const tuvs = Array.from(tu.children).filter((c) => c.localName === "tuv")

    // Pass 1: find the source tuv by srclang match (or fall back to first tuv).
    let srcTuv: Element | null = srclang
      ? (tuvs.find((t) => tuvLang(t) === srclang) ?? null)
      : (tuvs[0] ?? null)
    if (!srcTuv && tuvs.length >= 1) srcTuv = tuvs[0]

    // Pass 2: find the first tuv whose lang differs from the source lang.
    const srcLang = srcTuv ? tuvLang(srcTuv) : ""
    let tgtTuv: Element | null = tuvs.find((t) => tuvLang(t) !== srcLang && t !== srcTuv) ?? null

    // Fallback: if still no target, take the second tuv (handles no-lang-attr edge case)
    if (!tgtTuv && tuvs.length >= 2) tgtTuv = tuvs[1]

    const srcSeg = srcTuv
      ? Array.from(srcTuv.children).find((c) => c.localName === "seg")
      : null
    const tgtSeg = tgtTuv
      ? Array.from(tgtTuv.children).find((c) => c.localName === "seg")
      : null

    const original = srcSeg ? codeAwareTextContent(srcSeg).trim() : ""
    const translated = tgtSeg ? codeAwareTextContent(tgtSeg).trim() : ""

    if (!original) continue

    // Context: tu tuid attribute or a <prop type="x-id"> value
    const tuId = tu.getAttribute("tuid") || ""
    const propEl = Array.from(tu.children).find((c) => c.localName === "prop")
    const context = tuId || (propEl ? textContent(propEl).trim() : "") || uuid()

    // <note> as additional context label
    const noteEl = Array.from(tu.children).find((c) => c.localName === "note")
    const note = noteEl ? textContent(noteEl).trim() : ""

    const meta: TmxSegmentMeta = {
      ...(tuId ? { tuid: tuId } : {}),
      srcLang: srcTuv ? tuvLang(srcTuv) : srclang,
      ...(tgtTuv ? { tgtLang: tuvLang(tgtTuv) } : {}),
      srcSegXml: srcSeg ? serializeInner(srcSeg) : "",
      ...(tgtSeg ? { tgtSegXml: serializeInner(tgtSeg) } : {}),
    }

    results.push({
      id: uuid(),
      original,
      translated,
      context: note ? `${context} — ${note}` : context,
      group: tuId || context,
      type: "text",
      metadata: { tmx: meta },
    })
  }

  return results
}
