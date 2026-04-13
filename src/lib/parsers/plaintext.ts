import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"

export function extractPlaintextStrings(content: string): TranslatableString[] {
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0)
  const results: TranslatableString[] = []

  paragraphs.forEach((para, index) => {
    const trimmed = para.trim()
    const segments = splitIntoSegments(trimmed)

    for (const seg of segments) {
      results.push({
        id: uuid(),
        original: seg.text,
        translated: "",
        context: `Paragraph ${index + 1}`,
        group: seg.group,
        type: "text",
      })
    }
  })

  return results
}
