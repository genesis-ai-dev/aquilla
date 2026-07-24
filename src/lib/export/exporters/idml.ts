// Client-side IDML export with translation injection — SURGICAL STRING APPROACH.
//
// Mirrors the DOCX exporter's philosophy (./docx.ts) and the codex-editor
// desktop app's proven IDML round-trip (webviews/.../importers/indesign/
// idmlExporter.ts): InDesign is byte-fragile, so we never DOMParser+
// XMLSerializer the story XML. Only the text inside <Content> elements of
// translated paragraphs changes; every other byte of every zip part —
// designmap, styles, spreads, fonts, untranslated stories — stays identical.
//
// Injection walks the SAME block enumeration as the import parser
// (src/lib/parsers/idml.ts): top-level <ParagraphStyleRange> elements of each
// story, indexed over ALL of them (including empty ones), matched by the
// package-block locator retained at import. IDML shipped after normalized
// locators, so there is no positional legacy fallback — cells without a
// locator inject nothing.
//
// Fidelity:
//   1. Paragraph/style STRUCTURE fully preserved (ParagraphStyleRange,
//      CharacterStyleRange, applied styles, <Br/> paragraph terminators).
//   2. The translation lands in the paragraph's FIRST top-level <Content>
//      (keeping that run's character style); subsequent <Content> elements are
//      blanked but their run ELEMENTS remain, so run counts survive.
//   3. Newlines in the translation become <Content>…</Content><Br/><Content>…
//      sequences inside that first run.
//   4. Footnote/table paragraphs (nested ParagraphStyleRanges) are untouched,
//      matching the parser, which does not import them.
//   5. MIXED-FORMAT paragraphs (multiple differently-attributed runs) keep
//      only the first run's visible text — surfaced via `warnings`.

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { packageBlockKey, translationsByPackageBlock } from "../import-locators"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"

export interface IdmlExportResult {
  blob: Blob
  /** Number of paragraphs that received a translation. */
  injected: number
  /** Number of text-bearing paragraphs left as-is (no translation). */
  untouched: number
  /** Translated paragraphs whose source had mixed run formatting keep only
   *  the first run's styling — surfaced per segment (additive field). */
  warnings: { segment: string; detail: string }[]
}

/**
 * Takes the raw IDML bytes (fetched from the server side-car) and the file's
 * cells. Injects translations back into Stories/Story_*.xml by the reversible
 * package-block locator retained at import; multiple cells sharing a locator
 * (segments of one paragraph) are joined with a space by
 * translationsByPackageBlock.
 */
export async function exportIdml(
  rawIdmlBytes: ArrayBuffer,
  cells: CellData[],
): Promise<IdmlExportResult> {
  const zip = await JSZip.loadAsync(rawIdmlBytes)

  const storyFiles = Object.keys(zip.files).filter((f) =>
    /^Stories\/Story_[^/]+\.xml$/.test(f),
  )
  if (storyFiles.length === 0) {
    throw new Error("Malformed IDML: no Stories/Story_*.xml parts found in side-car")
  }

  const locatedTranslations = translationsByPackageBlock(cells)

  let injected = 0
  let untouched = 0
  const warnings: { segment: string; detail: string }[] = []

  for (const storyFile of storyFiles) {
    const xml = await zip.file(storyFile)!.async("string")
    const blocks = topLevelParagraphBlocks(xml)

    let rebuilt = ""
    let lastIndex = 0
    let mutated = false

    for (let n = 0; n < blocks.length; n++) {
      const block = xml.slice(blocks[n].start, blocks[n].end)
      rebuilt += xml.slice(lastIndex, blocks[n].start)
      lastIndex = blocks[n].end

      const located = locatedTranslations.get(
        packageBlockKey(storyFile, `ParagraphStyleRange[${n + 1}]`),
      )
      const translation = located?.plain ?? ""
      if (!translation) {
        rebuilt += block
        if (topLevelContents(block).some((c) => c.text.trim())) untouched++
        continue
      }

      const result = injectIntoBlock(block, translation)
      if (result === null) {
        rebuilt += block
        untouched++
        continue
      }
      if (result.mixedFormats) {
        warnings.push({
          segment: located!.label,
          detail:
            "paragraph had mixed inline formatting; translation keeps only the first run's styling",
        })
      }
      rebuilt += result.block
      injected++
      mutated = true
    }
    rebuilt += xml.slice(lastIndex)

    if (mutated) zip.file(storyFile, rebuilt)
  }

  const blob = await zip.generateAsync({ type: "blob", mimeType: IDML_MIME })
  return { blob, injected, untouched, warnings }
}

interface BlockSpan {
  start: number
  end: number
}

/**
 * Spans of top-level <ParagraphStyleRange> elements, by depth tracking —
 * nested ranges (footnotes, table cells) stay inside their parent's span.
 * Enumeration matches topLevelParagraphRanges in src/lib/parsers/idml.ts.
 */
function topLevelParagraphBlocks(xml: string): BlockSpan[] {
  const tokenRegex = /<ParagraphStyleRange\b[^>]*>|<\/ParagraphStyleRange>/g
  const blocks: BlockSpan[] = []
  let depth = 0
  let blockStart = -1
  let m: RegExpExecArray | null

  while ((m = tokenRegex.exec(xml)) !== null) {
    const token = m[0]
    if (token.startsWith("</")) {
      depth--
      if (depth === 0) blocks.push({ start: blockStart, end: m.index + token.length })
    } else if (token.endsWith("/>")) {
      if (depth === 0) blocks.push({ start: m.index, end: m.index + token.length })
    } else {
      if (depth === 0) blockStart = m.index
      depth++
    }
  }
  return blocks
}

interface ContentSpan {
  start: number
  end: number
  openTag: string
  text: string
  /** Open tag of the enclosing CharacterStyleRange, "" when outside one. */
  runSignature: string
}

/**
 * <Content> elements of a paragraph block that belong to the paragraph itself —
 * i.e. NOT inside a nested ParagraphStyleRange (footnote/table text). Also
 * records each content's enclosing CharacterStyleRange open tag so the caller
 * can detect mixed run formatting.
 */
function topLevelContents(block: string): ContentSpan[] {
  const tokenRegex =
    /<ParagraphStyleRange\b[^>]*>|<\/ParagraphStyleRange>|<CharacterStyleRange\b[^>]*>|<\/CharacterStyleRange>|<Content\b[^>]*\/>|<Content\b[^>]*>[\s\S]*?<\/Content>/g
  const contents: ContentSpan[] = []
  // The block string opens with its own ParagraphStyleRange tag → depth 1.
  let depth = 0
  let runSignature = ""
  let m: RegExpExecArray | null

  while ((m = tokenRegex.exec(block)) !== null) {
    const token = m[0]
    if (token.startsWith("</ParagraphStyleRange")) {
      depth--
    } else if (token.startsWith("<ParagraphStyleRange")) {
      if (!token.endsWith("/>")) depth++
    } else if (token.startsWith("</CharacterStyleRange")) {
      if (depth === 1) runSignature = ""
    } else if (token.startsWith("<CharacterStyleRange")) {
      if (depth === 1 && !token.endsWith("/>")) runSignature = token
    } else if (depth === 1) {
      const openEnd = token.indexOf(">")
      const selfClosing = token.endsWith("/>") && !token.includes("</Content>")
      contents.push({
        start: m.index,
        end: m.index + token.length,
        openTag: selfClosing ? token.slice(0, -2).trimEnd() + ">" : token.slice(0, openEnd + 1),
        text: selfClosing ? "" : token.slice(openEnd + 1, token.lastIndexOf("</Content>")),
        runSignature,
      })
    }
  }
  return contents
}

/**
 * Replace the paragraph's visible text with the translation: first content
 * element carries it (newlines becoming <Br/>-separated content runs), the
 * rest are emptied in place. Returns null when the block has no content
 * element to write into.
 */
function injectIntoBlock(
  block: string,
  translation: string,
): { block: string; mixedFormats: boolean } | null {
  const contents = topLevelContents(block)
  if (contents.length === 0) return null

  const textBearingSignatures = new Set(
    contents.filter((c) => c.text.trim()).map((c) => c.runSignature),
  )

  const injectedXml = translation
    .split("\n")
    .map(escapeXml)
    .join("</Content><Br/><Content>")

  let rebuilt = ""
  let lastIndex = 0
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i]
    rebuilt += block.slice(lastIndex, c.start)
    rebuilt += i === 0 ? `${c.openTag}${injectedXml}</Content>` : `${c.openTag}</Content>`
    lastIndex = c.end
  }
  rebuilt += block.slice(lastIndex)

  return { block: rebuilt, mixedFormats: textBearingSignatures.size > 1 }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
