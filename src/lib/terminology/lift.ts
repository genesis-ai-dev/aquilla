/**
 * LIFT (Lexicon Interchange FormaT) import for Concept[] — AQU-684.
 *
 * LIFT is the interchange format FLEx (SIL FieldWorks Language Explorer)
 * writes from *File → Export → Lexicon (LIFT 0.13 XML)*. It is the only FLEx
 * export that carries the whole lexicon losslessly, so it is what a partner
 * hands us when they say "here is our FLEx dictionary".
 *
 * Shape (abridged — one entry, one sense):
 *
 *   <lift version="0.13" producer="SIL.FLEx">
 *     <entry guid="…" id="trang_1">
 *       <lexical-unit><form lang="pmy"><text>trang</text></form></lexical-unit>
 *       <citation><form lang="pmy"><text>trang</text></form></citation>
 *       <variant><form lang="pmy"><text>terang</text></form></variant>
 *       <sense id="…">
 *         <gloss lang="en"><text>light</text></gloss>
 *         <definition><form lang="en"><text>the natural agent …</text></form></definition>
 *       </sense>
 *     </entry>
 *   </lift>
 *
 * ## Direction — why the gloss becomes the source term
 *
 * A FLEx lexicon documents a *vernacular* language: the headword
 * (`lexical-unit` / `citation`) is in the vernacular and the `gloss` is in the
 * analysis language (usually English or a national language). An Aquilla
 * Concept runs the other way round — `sourceTerm` is what the translator
 * translates *from* and `renderings` are what they should write in the target.
 *
 * For the workflow this issue came from (Biblica ETT translating Paratext USFM
 * *into* the vernacular), the useful mapping is therefore inverted:
 *
 *   gloss / definition (analysis language) → `sourceTerm`
 *   citation or lexical-unit headword      → `preferred` rendering
 *   variant forms                          → `admitted` renderings
 *   sense definition                       → `notes`
 *
 * Senses glossed identically across entries merge into ONE concept carrying
 * every headword as a rendering — that is exactly the "these are the accepted
 * words for X" list a termbase wants, and it collapses FLEx's homograph
 * entries (light¹ noun / light² adjective) without losing either form.
 *
 * ## Language selection
 *
 * A FLEx export routinely carries glosses in several analysis languages. The
 * dominant `gloss` language in the file wins (ties → first seen) unless the
 * caller names one; likewise the dominant `lexical-unit` language for
 * headwords. A sense with no gloss in the chosen language falls back to its
 * first gloss rather than being dropped — a partner file with sporadic gaps
 * still imports, which matters more than a perfectly monolingual column.
 *
 * ## Not covered
 *
 * `.lift-ranges` sidecars, audio/picture references, relations, reversal
 * indexes and FLEx's SFM/MDF export. Entries FLEx has tombstoned
 * (`dateDeleted`) are skipped.
 */

import { v4 as uuid } from "uuid"
import {
  parseXmlLite,
  elementsByTagName,
  isElement,
  textContent,
  getAttribute,
  type XmlElement,
} from "@/lib/parsers/xml-lite"
import type { Concept, TermRendering } from "./types"

export interface LiftImportOptions {
  /** Analysis-language code to read glosses/definitions in. Default: the file's dominant gloss language. */
  analysisLang?: string
  /** Vernacular-language code to read headwords in. Default: the file's dominant lexical-unit language. */
  vernacularLang?: string
}

/**
 * True when this text is a LIFT document. Sniffs the root element rather than
 * the file name: FLEx writes `.lift`, but partners re-save as `.xml` and mail
 * it on, and the extension is the thing that gets lost in transit.
 */
export function looksLikeLift(text: string): boolean {
  return /<lift[\s>]/i.test(text.slice(0, 4096))
}

/** Parse a LIFT XML string into Concept[]. Throws on malformed XML. */
export function importConceptsLift(xml: string, options: LiftImportOptions = {}): Concept[] {
  const doc = parseXmlLite(xml)
  const entries = elementsByTagName(doc, "entry").filter(
    (entry) => getAttribute(entry, "dateDeleted") === null,
  )
  if (entries.length === 0) return []

  const analysisLang =
    options.analysisLang ??
    dominantLang(entries.flatMap((e) => elementsByTagName(e, "gloss")))
  const vernacularLang =
    options.vernacularLang ??
    dominantLang(
      entries.flatMap((e) =>
        childrenByTagName(e, "lexical-unit").flatMap((lu) => childrenByTagName(lu, "form")),
      ),
    )

  // Accumulate renderings per source term (case-insensitive key → canonical
  // casing of the first occurrence), mirroring the CSV importer's grouping.
  const order: string[] = []
  const byKey = new Map<string, { sourceTerm: string; notes: string; renderings: TermRendering[] }>()

  for (const entry of entries) {
    const headword =
      formText(childrenByTagName(entry, "citation")[0], vernacularLang) ||
      formText(childrenByTagName(entry, "lexical-unit")[0], vernacularLang)
    const variants = childrenByTagName(entry, "variant")
      .map((variant) => formText(variant, vernacularLang))
      .filter((form) => form !== "" && form !== headword)
    // A `<variant ref="…"/>` with no form of its own leaves nothing to render;
    // an entry with no headword either is not a term, so skip it whole.
    if (!headword && variants.length === 0) continue

    for (const sense of elementsByTagName(entry, "sense")) {
      const definition = formText(childrenByTagName(sense, "definition")[0], analysisLang)
      const gloss = pickGloss(sense, analysisLang)
      const sourceTerm = gloss || definition
      if (!sourceTerm) continue

      const key = sourceTerm.toLocaleLowerCase()
      if (!byKey.has(key)) {
        order.push(key)
        byKey.set(key, { sourceTerm, notes: "", renderings: [] })
      }
      const bucket = byKey.get(key)!
      // Using the definition AS the headword must not also repeat it as a note.
      if (!bucket.notes && gloss) bucket.notes = definition
      if (headword) addRendering(bucket.renderings, headword, "preferred")
      for (const variant of variants) addRendering(bucket.renderings, variant, "admitted")
    }
  }

  const now = new Date().toISOString()
  return order.map((key) => {
    const { sourceTerm, notes, renderings } = byKey.get(key)!
    return {
      id: uuid(),
      sourceTerm,
      renderings,
      notes: notes || undefined,
      status: "active" as const,
      createdAt: now,
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Direct-child elements with this tag name — NOT `elementsByTagName`, which is deep. */
function childrenByTagName(parent: XmlElement | undefined, tagName: string): XmlElement[] {
  if (!parent) return []
  return parent.children.filter(
    (child): child is XmlElement => isElement(child) && child.tagName === tagName,
  )
}

/**
 * Text of `<form lang="…"><text>…</text></form>` under `parent`, preferring
 * the requested language and falling back to the first form present.
 */
function formText(parent: XmlElement | undefined, lang: string | undefined): string {
  const forms = childrenByTagName(parent, "form")
  if (forms.length === 0) return ""
  const preferred = lang ? forms.find((f) => getAttribute(f, "lang") === lang) : undefined
  return textContent(preferred ?? forms[0]).trim()
}

/** A sense's gloss in the analysis language, else its first gloss. */
function pickGloss(sense: XmlElement, lang: string | undefined): string {
  const glosses = childrenByTagName(sense, "gloss")
  if (glosses.length === 0) return ""
  const preferred = lang ? glosses.find((g) => getAttribute(g, "lang") === lang) : undefined
  return textContent(preferred ?? glosses[0]).trim()
}

/** Most frequent `lang` attribute across these elements; ties go to first seen. */
function dominantLang(elements: XmlElement[]): string | undefined {
  const counts = new Map<string, number>()
  for (const element of elements) {
    const lang = getAttribute(element, "lang")
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  // Map iterates in insertion order, so a tie keeps the first-seen language.
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang
      bestCount = count
    }
  }
  return best
}

/**
 * Add a rendering unless an equal one (case-insensitively) is already there.
 * A form seen as both a headword and someone else's variant keeps the stronger
 * `preferred` status.
 */
function addRendering(
  renderings: TermRendering[],
  rendering: string,
  status: TermRendering["status"],
): void {
  const normalized = rendering.toLocaleLowerCase()
  const existing = renderings.find((r) => r.rendering.toLocaleLowerCase() === normalized)
  if (!existing) {
    renderings.push({ rendering, status })
    return
  }
  if (status === "preferred") existing.status = "preferred"
}
