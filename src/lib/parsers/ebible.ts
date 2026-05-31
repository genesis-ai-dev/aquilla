import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import vrefRaw from "./ebible/vref.txt?raw"

export interface EBibleTranslation {
  id: string // "<languageCode>-<translationId>"
  translationId: string
  languageCode: string
  languageName: string
  languageNameInEnglish: string
  title: string
  description: string
  copyright: string
  redistributable: boolean
  downloadable: boolean
  homeDomain: string
  otBooks: number
  ntBooks: number
  textDirection: string
  updateDate: string
}

const CORPUS_BASE = "https://raw.githubusercontent.com/BibleNLP/ebible/main"

let vrefCache: string[] | null = null
let translationsCache: EBibleTranslation[] | null = null

export function getVrefs(): string[] {
  if (vrefCache) return vrefCache
  vrefCache = vrefRaw.split(/\r?\n/).filter((line) => line.length > 0)
  return vrefCache
}

// Minimal CSV parser for the translations.csv format:
// - fields may or may not be quoted
// - quoted fields can contain commas
// - escaped quotes are "" inside a quoted field
// - BOM may prefix the first character
function parseCsv(text: string): string[][] {
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ",") {
      row.push(field)
      field = ""
      i++
      continue
    }
    if (ch === "\r") {
      i++
      continue
    }
    if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      i++
      continue
    }
    field += ch
    i++
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

export async function fetchTranslationsList(): Promise<EBibleTranslation[]> {
  if (translationsCache) return translationsCache

  const res = await fetch(`${CORPUS_BASE}/metadata/translations.csv`)
  if (!res.ok) {
    throw new Error(`Failed to fetch eBible translations list (${res.status})`)
  }
  const text = await res.text()
  const rows = parseCsv(text)
  if (rows.length < 2) {
    throw new Error("eBible translations.csv was empty or malformed")
  }

  const header = rows[0]
  const col = (name: string) => header.indexOf(name)
  const idx = {
    languageCode: col("languageCode"),
    translationId: col("translationId"),
    languageName: col("languageName"),
    languageNameInEnglish: col("languageNameInEnglish"),
    title: col("title"),
    description: col("description"),
    copyright: col("Copyright"),
    redistributable: col("Redistributable"),
    downloadable: col("downloadable"),
    homeDomain: col("homeDomain"),
    otBooks: col("OTbooks"),
    ntBooks: col("NTbooks"),
    textDirection: col("textDirection"),
    updateDate: col("UpdateDate"),
  }

  const out: EBibleTranslation[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const languageCode = row[idx.languageCode]
    const translationId = row[idx.translationId]
    if (!languageCode || !translationId) continue
    out.push({
      id: `${languageCode}-${translationId}`,
      translationId,
      languageCode,
      languageName: row[idx.languageName] ?? "",
      languageNameInEnglish: row[idx.languageNameInEnglish] ?? "",
      title: row[idx.title] ?? translationId,
      description: row[idx.description] ?? "",
      copyright: row[idx.copyright] ?? "",
      redistributable: (row[idx.redistributable] ?? "").toLowerCase() === "true",
      downloadable: (row[idx.downloadable] ?? "").toLowerCase() === "true",
      homeDomain: row[idx.homeDomain] ?? "",
      otBooks: Number(row[idx.otBooks] ?? 0),
      ntBooks: Number(row[idx.ntBooks] ?? 0),
      textDirection: row[idx.textDirection] ?? "ltr",
      updateDate: row[idx.updateDate] ?? "",
    })
  }

  // Filter to only translations whose corpus .txt file exists in the upstream repo.
  // The `downloadable` column in translations.csv is "True" for all 1349 translations
  // that have a corpus file; the 13 "False" entries 404 when fetched.
  translationsCache = out.filter((t) => t.downloadable)
  return translationsCache
}

// For tests that want to stub out the translations cache.
export function __setTranslationsCacheForTest(
  cache: EBibleTranslation[] | null
): void {
  translationsCache = cache
}

// Streams a corpus text file, calling onProgress with (bytesReceived, totalBytes)
// where totalBytes is 0 if the server didn't send a Content-Length.
//
// Note: fetchTranslationsList() filters to downloadable=True entries only (see below).
// The 13 non-downloadable entries in translations.csv correspond to translations whose
// corpus .txt files are absent from the BibleNLP/ebible GitHub repo — fetching them
// returns a 404. Filtering on the `downloadable` column eliminates all known 404 cases.
export async function fetchTranslationText(
  id: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${CORPUS_BASE}/corpus/${id}.txt`, { signal })
  if (!res.ok) {
    throw new Error(`Failed to download translation '${id}' (${res.status})`)
  }

  const total = Number(res.headers.get("Content-Length") ?? 0)
  if (!res.body || !onProgress) {
    return res.text()
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let received = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    chunks.push(decoder.decode(value, { stream: true }))
    onProgress(received, total)
  }
  chunks.push(decoder.decode())
  return chunks.join("")
}

// Zip each line of the corpus with the matching vref. Empty lines = missing
// verses (skipped). Lines containing only `<range>` are continuation markers
// for a verse range (also skipped — the actual text lives on the prior line).
export function parseEBibleCorpus(corpusText: string): TranslatableString[] {
  const vrefs = getVrefs()
  const lines = corpusText.split(/\r?\n/)
  const limit = Math.min(lines.length, vrefs.length)

  const out: TranslatableString[] = []
  for (let i = 0; i < limit; i++) {
    const raw = lines[i]
    if (!raw) continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed === "<range>") continue

    const vref = vrefs[i]
    const bookId = vref.split(" ")[0] || "UNK"
    const section = vref.split(":")[0]  // e.g. "GEN 1" from "GEN 1:1"

    out.push({
      id: uuid(),
      original: trimmed,
      translated: "",
      context: vref,
      group: bookId,
      section,
      globalReferences: [vref],
      type: "verse",
    })
  }

  return out
}

// For tests that want to stub out the bundled vref list.
export function __setVrefsForTest(vrefs: string[] | null): void {
  vrefCache = vrefs
}
