import { v4 as uuid } from "uuid"
import type { TranslatableString, CellType } from "./types"
import { splitIntoSegments } from "./text-splitter"

export interface UsfmBookResult {
  bookId: string
  strings: TranslatableString[]
}

export function extractUsfmStrings(content: string): UsfmBookResult[] {
  const hasId = /\\id\s/.test(content)

  if (!hasId) {
    return [parseBookSection(content, "unknown")]
  }

  const sections = content.split(/(?=\\id\s)/).filter((s) => s.trim().length > 0)
  return sections.map((section) => {
    const idMatch = section.match(/\\id\s+(\S+)/)
    const bookId = idMatch ? idMatch[1] : "unknown"
    return parseBookSection(section, bookId)
  })
}

function parseBookSection(section: string, bookId: string): UsfmBookResult {
  const lines = section.split("\n")
  const strings: TranslatableString[] = []
  let chapter = 0
  let verse = 0

  function addString(text: string, context: string, type: CellType) {
    const segments = splitIntoSegments(text)
    for (const seg of segments) {
      strings.push({
        id: uuid(),
        original: seg.text,
        translated: "",
        context,
        group: seg.group,
        type,
      })
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("\\id ")) continue

    const chapterMatch = trimmed.match(/^\\c\s+(\d+)/)
    if (chapterMatch) {
      chapter = parseInt(chapterMatch[1])
      verse = 0
      continue
    }

    const verseMatch = trimmed.match(/^\\v\s+(\d+)\s+(.*)/)
    if (verseMatch) {
      verse = parseInt(verseMatch[1])
      addString(verseMatch[2], `${bookId} ${chapter}:${verse}`, "verse")
      continue
    }

    const sectionMatch = trimmed.match(/^\\s\d?\s+(.*)/)
    if (sectionMatch) {
      addString(sectionMatch[1], `${bookId} ${chapter}`, "heading")
      continue
    }

    if (/^\\p\s*$/.test(trimmed)) continue

    const paratextMatch = trimmed.match(/^\\(mt|ms|r)\d?\s+(.*)/)
    if (paratextMatch) {
      addString(paratextMatch[2], bookId, "paratext")
      continue
    }

    if (!trimmed.startsWith("\\") && strings.length > 0) {
      const last = strings[strings.length - 1]
      last.original += " " + trimmed
    }
  }

  return { bookId, strings }
}
