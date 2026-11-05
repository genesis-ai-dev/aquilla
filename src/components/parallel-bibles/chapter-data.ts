// One loaded chapter of one version, in the shape both panel views read.

import { flattenHelloaoContent, type HelloaoChapterResponse } from "@/lib/parsers/helloao"
import type { ChapterShape } from "@/lib/parallel-bibles/versification"

export type PassageBlock =
  | { type: "verse"; number: number; text: string }
  | { type: "heading"; text: string; psalmTitle: boolean }

export interface ChapterData {
  /** verse number → flattened text */
  verses: Map<number, string>
  /** The whole chapter in order, headings included, for the passage view. */
  blocks: PassageBlock[]
  shape: ChapterShape
  error?: string
}

export function chapterKey(versionId: string, book: string, chapter: number): string {
  return `${versionId}/${book}/${chapter}`
}

export function chapterDataFromResponse(res: HelloaoChapterResponse): ChapterData {
  const verses = new Map<number, string>()
  const blocks: PassageBlock[] = []
  let hasPsalmTitle = false
  for (const node of res.chapter.content) {
    if (node.type === "verse") {
      const text = flattenHelloaoContent(node.content) ?? ""
      verses.set(node.number, text)
      blocks.push({ type: "verse", number: node.number, text })
    } else if (node.type === "heading" || node.type === "hebrew_subtitle") {
      const psalmTitle = node.type === "hebrew_subtitle"
      if (psalmTitle) hasPsalmTitle = true
      const text = flattenHelloaoContent(node.content) ?? ""
      if (text) blocks.push({ type: "heading", text, psalmTitle })
    }
  }
  return { verses, blocks, shape: { verseCount: verses.size, hasPsalmTitle } }
}

export function emptyChapterData(error?: string): ChapterData {
  return { verses: new Map(), blocks: [], shape: { verseCount: 0, hasPsalmTitle: false }, error }
}
