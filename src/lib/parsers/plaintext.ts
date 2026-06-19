import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"

export function extractPlaintextStrings(content: string): TranslatableString[] {
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0)
  const results: TranslatableString[] = []

  paragraphs.forEach((para, index) => {
    const trimmed = para.trim()
    const segments = splitIntoSegments(trimmed)

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      results.push({
        id: uuid(),
        original: seg.text,
        translated: "",
        context: `Paragraph ${index + 1}`,
        group: seg.group,
        type: "text",
        // D2: first sub-cell of each paragraph block carries paragraphStart; continuations do not.
        ...(i === 0 ? { paragraphStart: true } : {}),
      })
    }
  })

  return results
}
