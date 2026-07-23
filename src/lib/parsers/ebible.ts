import { v4 as uuid } from "uuid"
import { proxyOrigin } from "@/lib/net/resource-proxy"
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

// Routed through the same-origin resource proxy when configured (AQU-627);
// transparent no-op when VITE_RESOURCES_BASE is unset.
const CORPUS_BASE = `${proxyOrigin("https://raw.githubusercontent.com")}/BibleNLP/ebible/main`

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

// HTTP statuses worth retrying: transient auth hiccups, rate-limiting, and
// upstream/server errors. 404 is deliberately excluded — fetchTranslationsList()
// already filters to downloadable=True, so a 404 here means a real mismatch
// (bad slug), not a transient condition, and retrying it would just waste time.
const RETRYABLE_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504])

const MAX_DOWNLOAD_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 500

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status)
}

function describeUpstreamFailure(id: string, status: number, statusText: string): string {
  if (status === 401 || status === 403) {
    return (
      `Couldn't reach the eBible Corpus: upstream returned HTTP ${status} for '${id}'. ` +
      `This is usually a temporary rate-limit from raw.githubusercontent.com, not a problem ` +
      `with your session — please try the import again in a minute.`
    )
  }
  if (status === 429) {
    return (
      `The eBible Corpus is rate-limiting downloads (HTTP 429) for '${id}'. ` +
      `Please wait a minute and try again.`
    )
  }
  if (status === 404) {
    return `Translation '${id}' was not found in the eBible Corpus (HTTP 404).`
  }
  return `Failed to download translation '${id}' (HTTP ${status}${statusText ? ` ${statusText}` : ""}).`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Streams a corpus text file, calling onProgress with (bytesReceived, totalBytes)
// where totalBytes is 0 if the server didn't send a Content-Length.
//
// Note: fetchTranslationsList() filters to downloadable=True entries only (see below).
// The 13 non-downloadable entries in translations.csv correspond to translations whose
// corpus .txt files are absent from the BibleNLP/ebible GitHub repo — fetching them
// returns a 404. Filtering on the `downloadable` column eliminates all known 404 cases.
//
// This fetch goes straight to GitHub's raw-content CDN with no auth of ours involved
// (no sync token, no session JWT) — a 401/403 here is an upstream rate-limit/abuse
// heuristic, not our auth expiring. Both the initial request and a failure mid-stream
// (the reader loop throwing) are retried with backoff before giving up; each retry
// restarts the byte counter (raw.githubusercontent.com's Range support for a browser
// fetch is not reliable enough to depend on for resume), but a large majority of
// failures are transient and succeed well within MAX_DOWNLOAD_ATTEMPTS.
export async function fetchTranslationText(
  id: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  // eBible corpus filenames use the pattern "{languageCode}-{translationId}.txt"
  // where hyphens *within* the translationId are replaced by underscores.
  // e.g. id "eng-eng-kjv" → file "eng-eng_kjv.txt"
  //      id "abt-abt-maprik" → file "abt-abt_maprik.txt"
  const [langCode, ...rest] = id.split('-')
  const fileSlug = `${langCode}-${rest.join('_')}`
  const url = `${CORPUS_BASE}/corpus/${fileSlug}.txt`

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error("Import cancelled")

    try {
      return await attemptDownload(url, id, onProgress, signal)
    } catch (err) {
      if (signal?.aborted) throw new Error("Import cancelled")

      const retryable = err instanceof RetryableDownloadError
      lastError = err instanceof Error ? err : new Error(String(err))

      if (!retryable || attempt === MAX_DOWNLOAD_ATTEMPTS) {
        if (retryable) {
          // Exhausted retries on a recoverable condition — say so explicitly
          // rather than surfacing the last raw attempt's message alone.
          throw new Error(
            `${lastError.message} Retried ${MAX_DOWNLOAD_ATTEMPTS} times without success — ` +
            `please check your connection and try again.`
          )
        }
        throw lastError
      }

      // Exponential backoff before the next attempt.
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
    }
  }

  // Unreachable (loop always returns or throws), but keeps TS satisfied.
  throw lastError ?? new Error(`Failed to download translation '${id}'`)
}

/** Marks a thrown error as safe to retry (transient upstream condition). */
class RetryableDownloadError extends Error {}

async function attemptDownload(
  url: string,
  id: string,
  onProgress: ((received: number, total: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const message = describeUpstreamFailure(id, res.status, res.statusText)
    if (isRetryableStatus(res.status)) throw new RetryableDownloadError(message)
    throw new Error(message)
  }

  const total = Number(res.headers.get("Content-Length") ?? 0)
  if (!res.body || !onProgress) {
    return res.text()
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let received = 0

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      chunks.push(decoder.decode(value, { stream: true }))
      onProgress(received, total)
    }
  } catch (err) {
    // A stream can fail mid-read (connection reset, upstream cutting the
    // response short) even after a 200 — treat this the same as a retryable
    // upstream hiccup rather than surfacing a raw reader exception.
    if (signal?.aborted) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new RetryableDownloadError(
      `Connection to the eBible Corpus was interrupted while downloading '${id}' (${detail}).`
    )
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
