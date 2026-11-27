/**
 * AQU-2673: the header action batches whole books. A book is a file that
 * carries a book code — the shape a Bible API import already writes, one
 * file per book. The open-file dialog does not switch files; this list is
 * the other level.
 */
import { compareByCanonicalBookOrder, getBookName } from "@/lib/file-labeling/bible-book-names"

export interface BatchBookFile {
  id: string
  name: string
  bookCode?: string | null
}

export interface BatchBook {
  id: string
  bookCode: string
  /** The book name, with the file name beside it when two files share a code. */
  name: string
}

export function listBatchBooks(files: readonly BatchBookFile[]): BatchBook[] {
  const withCode = files.filter((file): file is BatchBookFile & { bookCode: string } =>
    Boolean(file.bookCode && file.bookCode.trim()),
  )
  const counts = new Map<string, number>()
  for (const file of withCode) {
    const code = file.bookCode.toUpperCase()
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return [...withCode]
    .sort((a, b) => compareByCanonicalBookOrder(a.bookCode, b.bookCode) || a.name.localeCompare(b.name))
    .map((file) => {
      const code = file.bookCode.toUpperCase()
      const book = getBookName(code) ?? code
      const shared = (counts.get(code) ?? 0) > 1
      return { id: file.id, bookCode: code, name: shared ? file.name : book }
    })
}
