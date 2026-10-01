// Server-side client for the TaBiThA Copilot API (copilot.tabitha.bible, MIT,
// CanIL). One verse in → one translator brief out: a simple-English rendering
// plus "check your translation" semantic notes, and SIL translator notes /
// cultural background when Aquifer has them for the verse.
//
// Why a proxy and not a browser fetch:
//   * The upstream sends no CORS headers for our origin.
//   * It streams NDJSON progress lines (`{"type":"step"}`…) before the one
//     `{"type":"brief"}` or `{"type":"error"}` line we want — we collapse that
//     to a small, stable JSON shape here, so an upstream reshuffle breaks one
//     parser, not the SPA.
//   * It rate-limits at 60 req/min per client IP and our Worker egress is
//     shared by every user, so answers are cached in the Workers Cache for a
//     day (briefs are deterministic per verse; a cold verse takes ~35s
//     upstream, a warm one ~3s).
//
// Host allowlist: callers pass a USFM book code + numbers, never a URL. The
// book code must be in BOOK_NAMES or the call is rejected before any fetch.
//
// Upstream carries no versioning guarantee ("built for TaBiThA's own UIs
// first"), so parseCopilotStream validates defensively and never throws.

const BASE_URL = "https://copilot.tabitha.bible"
const USER_AGENT = "Aquilla/1.0 (+https://aquilla.app)"
/** A never-requested verse took ~35s upstream when probed (2026-09-28). */
const TIMEOUT_MS = 45_000
const MAX_RESPONSE_BYTES = 200_000
const CACHE_SECONDS = 86_400

export type TabithaResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface TabithaNote {
  /** Name of the semantic feature that triggered the note, e.g. "Intent/Result". */
  topic: string
  meaning: string
  check: string
  quotedText: string
}

export interface TabithaVerseBrief {
  /** False when upstream has no encoded text for this verse (coverage gap). */
  available: boolean
  lwcText: string
  notes: TabithaNote[]
  translatorNotes: string[]
  culturalBackground: { term: string; summary: string }[]
}

/**
 * USFM code → the book name the Copilot API resolves. Mirrors TaBiThA's own
 * USFM_BOOK_CODES (packages/types/src/patterns/scripture.ts) — note
 * "Song of Solomon", the only spelling their Sources API accepts.
 */
const BOOK_NAMES: Record<string, string> = {
  GEN: "Genesis", EXO: "Exodus", LEV: "Leviticus", NUM: "Numbers", DEU: "Deuteronomy",
  JOS: "Joshua", JDG: "Judges", RUT: "Ruth", "1SA": "1 Samuel", "2SA": "2 Samuel",
  "1KI": "1 Kings", "2KI": "2 Kings", "1CH": "1 Chronicles", "2CH": "2 Chronicles",
  EZR: "Ezra", NEH: "Nehemiah", EST: "Esther", JOB: "Job", PSA: "Psalms", PRO: "Proverbs",
  ECC: "Ecclesiastes", SNG: "Song of Solomon", ISA: "Isaiah", JER: "Jeremiah",
  LAM: "Lamentations", EZK: "Ezekiel", DAN: "Daniel", HOS: "Hosea", JOL: "Joel", AMO: "Amos",
  OBA: "Obadiah", JON: "Jonah", MIC: "Micah", NAM: "Nahum", HAB: "Habakkuk",
  ZEP: "Zephaniah", HAG: "Haggai", ZEC: "Zechariah", MAL: "Malachi",
  MAT: "Matthew", MRK: "Mark", LUK: "Luke", JHN: "John", ACT: "Acts", ROM: "Romans",
  "1CO": "1 Corinthians", "2CO": "2 Corinthians", GAL: "Galatians", EPH: "Ephesians",
  PHP: "Philippians", COL: "Colossians", "1TH": "1 Thessalonians", "2TH": "2 Thessalonians",
  "1TI": "1 Timothy", "2TI": "2 Timothy", TIT: "Titus", PHM: "Philemon", HEB: "Hebrews",
  JAS: "James", "1PE": "1 Peter", "2PE": "2 Peter", "1JN": "1 John", "2JN": "2 John",
  "3JN": "3 John", JUD: "Jude", REV: "Revelation",
}

/** Compose the upstream URL, or null when the ref can't be addressed. */
export function copilotVerseUrl(book: string, chapter: number, verse: number): string | null {
  const name = BOOK_NAMES[book.toUpperCase()]
  if (!name) return null
  if (!Number.isInteger(chapter) || !Number.isInteger(verse) || chapter < 1 || verse < 1) return null
  return `${BASE_URL}/${encodeURIComponent(name)}/${chapter}/${verse}`
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Collapse the NDJSON stream to one brief. A `type:"error"` line (unknown or
 * unencoded verse) is a normal "nothing here" answer, not a failure.
 */
export function parseCopilotStream(body: string): TabithaResult<TabithaVerseBrief> {
  for (const line of body.split("\n")) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (parsed.type === "error") {
      return {
        ok: true,
        data: { available: false, lwcText: "", notes: [], translatorNotes: [], culturalBackground: [] },
      }
    }
    if (parsed.type !== "brief") continue
    const notes = array(parsed.semantic_notes)
      .filter(isRecord)
      .map((n) => ({
        topic: isRecord(n.trigger) ? str(n.trigger.name) : "",
        meaning: str(n.meaning),
        check: str(n.check),
        quotedText: str(n.quoted_text),
      }))
      .filter((n) => n.meaning || n.check)
    return {
      ok: true,
      data: {
        available: true,
        lwcText: str(parsed.lwc_text),
        notes,
        translatorNotes: array(parsed.tnn_notes).map(str).filter(Boolean),
        culturalBackground: array(parsed.cultural_background)
          .filter(isRecord)
          .map((c) => ({ term: str(c.term), summary: str(c.summary) }))
          .filter((c) => c.summary),
      },
    }
  }
  return { ok: false, error: "tabitha returned no brief" }
}

async function fetchStream(url: string): Promise<TabithaResult<string>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/x-ndjson, application/json" },
    })
    if (!res.ok) return { ok: false, error: `tabitha ${res.status}` }
    const text = await res.text()
    return { ok: true, data: text.slice(0, MAX_RESPONSE_BYTES) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: controller.signal.aborted ? "tabitha request timed out" : msg }
  } finally {
    clearTimeout(timer)
  }
}

/** One verse's brief, via the Workers Cache. Never throws. */
export async function tabithaVerseBrief(
  book: string,
  chapter: number,
  verse: number,
): Promise<TabithaResult<TabithaVerseBrief>> {
  const url = copilotVerseUrl(book, chapter, verse)
  if (!url) return { ok: false, error: "unsupported reference" }

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const cacheKey = new Request(url, { method: "GET" })
  if (cache) {
    try {
      const hit = await cache.match(cacheKey)
      if (hit) return { ok: true, data: (await hit.json()) as TabithaVerseBrief }
    } catch {
      /* cache miss / unavailable — fall through to network */
    }
  }

  const stream = await fetchStream(url)
  if (!stream.ok) return stream
  const brief = parseCopilotStream(stream.data)
  if (brief.ok && cache) {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(brief.data), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_SECONDS}` },
        }),
      )
    } catch {
      /* cache write best-effort */
    }
  }
  return brief
}
