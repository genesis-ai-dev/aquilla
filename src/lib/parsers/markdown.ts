import { v4 as uuid } from "uuid"
import type { TranslatableString, CellType } from "./types"
import { splitIntoSegments } from "./text-splitter"

export function extractMarkdownStrings(content: string): TranslatableString[] {
  const lines = content.split("\n")
  const results: TranslatableString[] = []
  let paragraphLines: string[] = []

  function flushParagraph() {
    if (paragraphLines.length === 0) return
    const text = paragraphLines.join(" ")
    paragraphLines = []
    addEntry(text, "Paragraph", "text")
  }

  function addEntry(
    rawText: string,
    context: string,
    type: CellType,
    metadata?: Record<string, unknown>,
  ) {
    const plain = stripMarkdownInline(rawText)
    const html = markdownInlineToHtml(rawText)
    const segments = splitIntoSegments(plain)

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      results.push({
        id: uuid(),
        original: seg.text,
        originalHtml: segments.length === 1 && html !== plain ? html : undefined,
        translated: "",
        context,
        group: seg.group,
        type,
        ...(metadata ? { metadata } : {}),
        // D2: first sub-cell of each paragraph block carries paragraphStart; continuations do not.
        ...(i === 0 ? { paragraphStart: true } : {}),
      })
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "") {
      flushParagraph()
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      flushParagraph()
      addEntry(headingMatch[2], `Heading ${headingMatch[1].length}`, "heading")
      continue
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)/)
    if (ulMatch) {
      flushParagraph()
      addEntry(ulMatch[1], "List item", "list", { md: { listKind: "unordered" } })
      continue
    }

    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)/)
    if (olMatch) {
      flushParagraph()
      // Record list kind + the author's number so ordered lists round-trip as
      // ordered (block-style fidelity) instead of degrading to "- " bullets.
      addEntry(olMatch[2], "List item", "list", {
        md: { listKind: "ordered", index: Number(olMatch[1]) },
      })
      continue
    }

    const quoteMatch = trimmed.match(/^>\s*(.*)/)
    if (quoteMatch) {
      flushParagraph()
      addEntry(quoteMatch[1], "Blockquote", "blockquote")
      continue
    }

    paragraphLines.push(trimmed)
  }

  flushParagraph()
  return results
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
}

function markdownInlineToHtml(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
}
