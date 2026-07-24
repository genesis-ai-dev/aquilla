import JSZip from "jszip"
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"
import { assertSafeArchiveInputSize, assertSafeZipArchive } from "./zip-safety"

// IDML (Adobe InDesign Markup Language) is a zip of XML parts, like DOCX/PPTX.
// Translatable text lives in Stories/Story_*.xml as
//   <ParagraphStyleRange><CharacterStyleRange><Content>text</Content>…
// and designmap.xml lists the stories in document order.
//
// The translatable block is the TOP-LEVEL ParagraphStyleRange (one InDesign
// paragraph). ParagraphStyleRanges nested deeper — footnotes and table cells —
// are skipped in this slice; the round-trip exporter leaves them untouched.
// The exporter (src/lib/export/exporters/idml.ts) walks the exact same block
// enumeration, so `blockPath` indices must stay in lockstep with it.

export async function extractIdmlStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  assertSafeArchiveInputSize(buffer.byteLength, "IDML file")
  const zip = await JSZip.loadAsync(buffer)
  assertSafeZipArchive(zip, "IDML file")

  const storyFiles = await orderedStoryFiles(zip)
  if (storyFiles.length === 0) throw new Error("IDML file does not contain any stories")

  const results: TranslatableString[] = []

  for (const storyFile of storyFiles) {
    const xmlStr = await zip.file(storyFile)!.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")
    // The payload <Story> sits inside an <idPkg:Story> wrapper root.
    const story = doc.getElementsByTagName("Story")[0] ?? doc.documentElement

    const paragraphs = topLevelParagraphRanges(story)
    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const p = paragraphs[pIdx]
      const { plain, html, hasFormatting } = extractIdmlRuns(p)
      if (!plain.trim()) continue

      const style = styleLeafName(p.getAttribute("AppliedParagraphStyle"))
      const context = !style || style === "NormalParagraphStyle" ? "Paragraph" : style
      const type = style && /^(heading|title)/i.test(style)
        ? ("heading" as const)
        : ("text" as const)
      const segments = splitIntoSegments(plain)
      // blockPath indexes ALL top-level ParagraphStyleRanges (including empty
      // ones this loop skips), so parser and exporter never drift.
      const sourceLocation = {
        file: storyFile,
        blockPath: `ParagraphStyleRange[${pIdx + 1}]`,
      }

      for (let i = 0; i < segments.length; i++) {
        results.push({
          id: uuid(),
          original: segments[i].text,
          originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
          translated: "",
          context,
          group: segments[i].group,
          type,
          sourceLocation,
          // D2: first sub-cell of each paragraph block carries paragraphStart.
          ...(i === 0 ? { paragraphStart: true } : {}),
        })
      }
    }
  }

  return results
}

/**
 * Story files in document order. designmap.xml's <idPkg:Story src="…"/>
 * elements define the order; stories the designmap misses are appended in
 * name order so no text silently drops. Regex, not DOMParser: only the src
 * attributes matter and namespace-prefixed tag lookups vary across XML DOM
 * implementations.
 */
async function orderedStoryFiles(zip: JSZip): Promise<string[]> {
  const present = Object.keys(zip.files)
    .filter((f) => /^Stories\/Story_[^/]+\.xml$/.test(f))
    .sort()

  const ordered: string[] = []
  const designmap = zip.file("designmap.xml")
  if (designmap) {
    const xml = await designmap.async("string")
    const srcRegex = /<(?:idPkg:)?Story\b[^>]*\bsrc="([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = srcRegex.exec(xml)) !== null) {
      const src = m[1].replace(/^\.\//, "")
      if (zip.file(src) && !ordered.includes(src)) ordered.push(src)
    }
  }
  for (const f of present) {
    if (!ordered.includes(f)) ordered.push(f)
  }
  return ordered
}

/** ParagraphStyleRanges with no ParagraphStyleRange ancestor — one per
 *  InDesign paragraph. Excludes footnote/table paragraphs, which nest. */
function topLevelParagraphRanges(story: Element): Element[] {
  const all = story.getElementsByTagName("ParagraphStyleRange")
  const out: Element[] = []
  for (let i = 0; i < all.length; i++) {
    if (nearestAncestorByTag(all[i], "ParagraphStyleRange") === null) out.push(all[i])
  }
  return out
}

function nearestAncestorByTag(el: Element, tagName: string): Element | null {
  let cur = el.parentElement
  while (cur) {
    if (cur.tagName === tagName) return cur
    cur = cur.parentElement
  }
  return null
}

function extractIdmlRuns(p: Element): { plain: string; html: string; hasFormatting: boolean } {
  let plain = ""
  let html = ""
  let hasFormatting = false

  for (const range of characterRangesOf(p)) {
    const fontStyle = range.getAttribute("FontStyle") ?? ""
    const bold = /bold|black|heavy/i.test(fontStyle)
    const italic = /italic|oblique/i.test(fontStyle)
    const underline = range.getAttribute("Underline") === "true"
    const strike = range.getAttribute("StrikeThru") === "true"

    const children = range.children
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.tagName === "Br") {
        plain += "\n"
        html += "<br>"
        continue
      }
      if (child.tagName !== "Content") continue
      const text = child.textContent || ""
      if (!text) continue

      plain += text

      let htmlText = text
      if (bold) { htmlText = `<b>${htmlText}</b>`; hasFormatting = true }
      if (italic) { htmlText = `<i>${htmlText}</i>`; hasFormatting = true }
      if (underline) { htmlText = `<u>${htmlText}</u>`; hasFormatting = true }
      if (strike) { htmlText = `<s>${htmlText}</s>`; hasFormatting = true }
      html += htmlText
    }
  }

  // A paragraph's trailing <Br/> is its terminator, not content.
  return { plain: plain.replace(/\n+$/, ""), html, hasFormatting }
}

/** CharacterStyleRanges whose nearest ParagraphStyleRange ancestor is `p` —
 *  i.e. the paragraph's own runs, not those of a nested footnote paragraph. */
function characterRangesOf(p: Element): Element[] {
  const all = p.getElementsByTagName("CharacterStyleRange")
  const out: Element[] = []
  for (let i = 0; i < all.length; i++) {
    if (nearestAncestorByTag(all[i], "ParagraphStyleRange") === p) out.push(all[i])
  }
  return out
}

/**
 * Human style name from an applied-style path like
 * "ParagraphStyle/Heading 1" or "ParagraphStyle/$ID/NormalParagraphStyle".
 * IDML percent-encodes special characters in style names.
 */
function styleLeafName(applied: string | null): string | null {
  if (!applied) return null
  const leaf = applied.split("/").pop() || ""
  if (!leaf) return null
  try {
    return decodeURIComponent(leaf)
  } catch {
    return leaf
  }
}
