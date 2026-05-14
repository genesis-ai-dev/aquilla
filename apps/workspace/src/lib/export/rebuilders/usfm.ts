import type { ExportCell } from "@/lib/store/file-doc"

function cellText(cell: ExportCell): string {
  return cell.translated.trim() ? cell.translated : cell.original
}

function parseContext(context: string): { book?: string; chapter?: number; verse?: number } {
  const verseMatch = context.match(/^(\S+)\s+(\d+):(\d+)$/)
  if (verseMatch) return { book: verseMatch[1], chapter: parseInt(verseMatch[2]), verse: parseInt(verseMatch[3]) }
  const chapterMatch = context.match(/^(\S+)\s+(\d+)$/)
  if (chapterMatch) return { book: chapterMatch[1], chapter: parseInt(chapterMatch[2]) }
  const bookMatch = context.match(/^(\S+)$/)
  if (bookMatch) return { book: bookMatch[1] }
  return {}
}

export function rebuildUsfm(cells: ExportCell[]): string {
  if (cells.length === 0) return ""

  const books: { book: string; cells: ExportCell[] }[] = []
  const bookIndex = new Map<string, number>()

  for (const cell of cells) {
    const { book } = parseContext(cell.context)
    const key = book || "unknown"
    const idx = bookIndex.get(key)
    if (idx === undefined) {
      bookIndex.set(key, books.length)
      books.push({ book: key, cells: [cell] })
    } else {
      books[idx].cells.push(cell)
    }
  }

  const output: string[] = []

  for (const { book, cells: bookCells } of books) {
    const lines: string[] = [`\\id ${book}`]
    let currentChapter = 0

    for (const cell of bookCells) {
      const parsed = parseContext(cell.context)
      const text = cellText(cell)

      switch (cell.type) {
        case "paratext":
          lines.push(`\\mt ${text}`)
          break
        case "heading": {
          if (parsed.chapter !== undefined && parsed.chapter !== currentChapter) {
            lines.push(`\\c ${parsed.chapter}`)
            currentChapter = parsed.chapter
          }
          lines.push(`\\s ${text}`)
          break
        }
        case "verse": {
          if (parsed.chapter !== undefined && parsed.chapter !== currentChapter) {
            lines.push(`\\c ${parsed.chapter}`)
            currentChapter = parsed.chapter
          }
          if (parsed.verse !== undefined) {
            lines.push(`\\v ${parsed.verse} ${text}`)
          } else {
            lines.push(text)
          }
          break
        }
        default:
          lines.push(text)
      }
    }
    output.push(lines.join("\n"))
  }

  return output.join("\n\n")
}
