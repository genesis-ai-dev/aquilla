// Server-side Bible Knowledge Pack loader (AQU-1690).
//
// Autopilot reads the pack that bibletranslation.org publishes as static,
// versioned JSON: `{base}/manifest.json` and `{base}/{layer}/{BOOK}.json`
// (contract: bible-wiki pipeline/src/schemas/bkp.ts; SPA twin:
// src/lib/bible-data/pack-client.ts). Hardening follows the Aquifer client
// (../aquifer/client.ts):
//
//   • Allowlist. The base comes from env.BKP_BASE only, and must be https
//     (http is allowed for a local mock). Callers pass a book code, which must
//     look like a USFM code AND be a book the manifest lists; layer names are a
//     fixed set. Nothing a model or a cell says can point this at another URL.
//   • A timeout per request, a descriptive User-Agent, and a size ceiling.
//   • Workers Cache. Layer files are cached under a key that carries the pack
//     version, so a new version can never be answered by an old file; the
//     manifest is cached briefly, so a new version is seen within minutes.
//     Parsed layers are also kept in a small per-isolate LRU, so the waves of
//     one run do not re-parse a 3 MB file each.
//   • Typed failures, never a throw. The live site may serve an HTML page at a
//     pack URL until the pack is deployed there, so a body that is not the
//     JSON the contract describes is `invalid`, like a malformed file.

import type { Env } from "../../types"
import { checkWordFields, checkWordIds } from "../../../../db/shared/bible-checks/text-compact"
import type { TextWordInput } from "../../../../db/shared/bible-checks/types"
import { isSecondPersonWord } from "../../../../db/shared/bible-facts/facts"
import {
  isBkpQuestion,
  parseServerLayer,
  parseServerManifest,
  type BkpManifest,
  type BkpQuestion,
  type BkpWord,
  type ServerBkpLayer,
  type ServerBkpLayerData,
} from "./pack-types"

export const DEFAULT_BKP_BASE = "https://bibletranslation.org/bkp/v1"
const DEFAULT_USER_AGENT = "Aquilla/1.0 (+https://aquilla.app)"
const MANIFEST_TIMEOUT_MS = 5_000
const LAYER_TIMEOUT_MS = 10_000
const MANIFEST_MAX_BYTES = 1_000_000
/** The largest layer file today is a text layer of about 4.4 MB (LUK). */
const LAYER_MAX_BYTES = 8_000_000
const MANIFEST_CACHE_SECONDS = 300
/** A versioned layer URL never changes content. */
const LAYER_CACHE_SECONDS = 7 * 24 * 3600
/**
 * Parsed layers kept per isolate: five layers of three books (the text layer
 * compacted; AQU-1701: of the notes layer, only its questions).
 */
const MEMORY_ENTRIES = 15
const BOOK_CODE = /^[1-4]?[A-Z]{2,3}$/

/**
 * Why the pack did not load:
 *   offline   — not reachable now (network error, timeout, 5xx, 429);
 *   not-found — the pack has no such book or layer (or a 404);
 *   invalid   — something arrived, but not the JSON the contract describes
 *               (an HTML page, a wrong book, a bad base URL).
 */
export type BkpFailureReason = "offline" | "not-found" | "invalid"

export type BkpResult<T> = { ok: true; value: T } | { ok: false; reason: BkpFailureReason }

/**
 * The text layer as autopilot keeps it: the second-person words, with the
 * fields the facts read ("you" singular or plural), and (AQU-1697) the words
 * the Bible data checks read: number words, negators with their neighbours,
 * and each verse's last word (db/shared/bible-checks/text-compact.ts). A
 * full layer runs to ~4 MB of JSON and several times that parsed. AQU-1701:
 * also the verbs whose subject the people layer resolves, with their gloss,
 * for the referent question (P13: "…the one who answered?").
 */
export interface CompactTextLayer {
  book: string
  verses: Record<string, string[]>
  words: Record<string, Pick<BkpWord, "class" | "morph" | "person" | "number"> & TextWordInput>
}

export interface BookPack {
  version: string
  book: string
  voices: ServerBkpLayerData["voices"]
  structure: ServerBkpLayerData["structure"]
  people: ServerBkpLayerData["people"]
  /** Present only when the caller asked for it and it loaded. */
  text: CompactTextLayer | null
  /** AQU-1701: the book's Translation Questions (C1). Present only when the caller asked for them and they loaded. */
  questions: readonly BkpQuestion[] | null
}

type PackEnv = Pick<Env, "BKP_BASE" | "AQUIFER_USER_AGENT">

/** The configured base, or null when it is not an allowed URL. No trailing slash. */
export function bkpBase(env: PackEnv): string | null {
  const raw = (env.BKP_BASE?.trim() || DEFAULT_BKP_BASE).replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null
  if (url.search || url.hash || url.username || url.password) return null
  return raw
}

function defaultCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default
}

async function fetchJson(
  env: PackEnv,
  url: string,
  cacheKey: string,
  opts: { timeoutMs: number; maxBytes: number; cacheSeconds: number },
): Promise<BkpResult<unknown>> {
  const cache = defaultCache()
  const key = new Request(cacheKey, { method: "GET" })
  if (cache) {
    try {
      const hit = await cache.match(key)
      if (hit) return { ok: true, value: await hit.json() }
    } catch {
      /* a miss, an unreadable entry or no cache: fetch below */
    }
  }
  let res: Response
  try {
    res = await fetch(url, {
      headers: { "User-Agent": env.AQUIFER_USER_AGENT || DEFAULT_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch {
    return { ok: false, reason: "offline" }
  }
  if (!res.ok) {
    await res.body?.cancel()
    return { ok: false, reason: res.status >= 500 || res.status === 429 ? "offline" : "not-found" }
  }
  const declared = Number(res.headers.get("content-length") ?? "0")
  if ((res.headers.get("content-type") ?? "").includes("text/html") || declared > opts.maxBytes) {
    await res.body?.cancel()
    return { ok: false, reason: "invalid" }
  }
  let text: string
  try {
    text = await res.text()
  } catch {
    // A body cut off by the network is not the file's fault.
    return { ok: false, reason: "offline" }
  }
  if (text.length > opts.maxBytes) return { ok: false, reason: "invalid" }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid" }
  }
  if (cache) {
    try {
      await cache.put(
        key,
        new Response(text, {
          headers: { "content-type": "application/json", "cache-control": `max-age=${opts.cacheSeconds}` },
        }),
      )
    } catch {
      /* best effort */
    }
  }
  return { ok: true, value }
}

// ── Manifest ────────────────────────────────────────────────────────────────

let manifestMemo: { base: string; at: number; manifest: BkpManifest } | null = null

async function loadManifest(env: PackEnv, base: string): Promise<BkpResult<BkpManifest>> {
  if (manifestMemo && manifestMemo.base === base && Date.now() - manifestMemo.at < MANIFEST_CACHE_SECONDS * 1000) {
    return { ok: true, value: manifestMemo.manifest }
  }
  const url = `${base}/manifest.json`
  const fetched = await fetchJson(env, url, url, {
    timeoutMs: MANIFEST_TIMEOUT_MS,
    maxBytes: MANIFEST_MAX_BYTES,
    cacheSeconds: MANIFEST_CACHE_SECONDS,
  })
  if (!fetched.ok) return fetched
  const manifest = parseServerManifest(fetched.value)
  if (!manifest) return { ok: false, reason: "invalid" }
  manifestMemo = { base, at: Date.now(), manifest }
  return { ok: true, value: manifest }
}

// ── Layers ──────────────────────────────────────────────────────────────────

const memory = new Map<string, unknown>()

function remember(key: string, value: unknown): void {
  memory.delete(key)
  memory.set(key, value)
  while (memory.size > MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

/**
 * Only the words of a text layer that autopilot reads (see CompactTextLayer).
 * `subjects`: AQU-1701, the words whose subject the people layer resolves
 * (`impliedSubjectWords`); kept with their gloss.
 */
export function compactTextLayer(layer: ServerBkpLayerData["text"], subjects: ReadonlySet<string> = new Set()): CompactTextLayer {
  const verses: CompactTextLayer["verses"] = {}
  const words: CompactTextLayer["words"] = {}
  const checkIds = checkWordIds(layer)
  const withFields = (id: string) => checkIds.has(id) || subjects.has(id)
  for (const [ref, ids] of Object.entries(layer.verses)) {
    if (!Array.isArray(ids)) continue
    const kept = ids.filter((id) => {
      const word = Object.hasOwn(layer.words, id) ? layer.words[id] : undefined
      return word !== undefined && (isSecondPersonWord(word) || withFields(id))
    })
    if (kept.length === 0) continue
    verses[ref] = kept
    for (const id of kept) {
      const word = layer.words[id]
      const { class: wordClass, morph, person, number } = word
      words[id] = {
        class: wordClass,
        morph,
        ...(person ? { person } : {}),
        ...(number ? { number } : {}),
        ...(withFields(id) ? checkWordFields(word) : {}),
      }
    }
  }
  return { book: layer.book, verses, words }
}

/** AQU-1701: the words the people layer marks as a verb whose subject it resolves (P13 reads their gloss). */
export function impliedSubjectWords(people: ServerBkpLayerData["people"]): Set<string> {
  const out = new Set<string>()
  for (const [wordId, mention] of Object.entries(people.mentions)) {
    if (mention?.kind === "subject") out.add(wordId)
  }
  return out
}

/** AQU-1701: a notes layer's well-formed Translation Questions. The notes themselves are dropped. */
export function questionsOf(layer: ServerBkpLayerData["notes"]): BkpQuestion[] {
  return layer.questions.filter(isBkpQuestion).map(({ id, refs, q, a }) => ({ id, refs: [...refs], q, a }))
}

async function loadLayer<L extends ServerBkpLayer, T = ServerBkpLayerData[L]>(
  env: PackEnv,
  base: string,
  version: string,
  layer: L,
  book: string,
  /** Reduce the parsed layer before it is kept in memory. */
  shape: (parsed: ServerBkpLayerData[L]) => T = (parsed) => parsed as unknown as T,
): Promise<BkpResult<T>> {
  const memoKey = `${base}|${version}|${layer}|${book}`
  const remembered = memory.get(memoKey) as T | undefined
  if (remembered) {
    remember(memoKey, remembered)
    return { ok: true, value: remembered }
  }
  const url = `${base}/${layer}/${book}.json`
  // The version rides the cache key, not the request: a static host serves
  // the same file either way, and the key is what must change per version.
  const fetched = await fetchJson(env, url, `${url}?v=${encodeURIComponent(version)}`, {
    timeoutMs: LAYER_TIMEOUT_MS,
    maxBytes: LAYER_MAX_BYTES,
    cacheSeconds: LAYER_CACHE_SECONDS,
  })
  if (!fetched.ok) return fetched
  const parsed = parseServerLayer(layer, book, fetched.value)
  if (!parsed) return { ok: false, reason: "invalid" }
  const value = shape(parsed)
  remember(memoKey, value)
  return { ok: true, value }
}

/**
 * The voices, structure and people layers of one book (a USFM code such as
 * "JHN"), the text layer when `text` is set, and (AQU-1701) the notes layer's
 * Translation Questions when `questions` is set. The three are required: if
 * one fails, the result is that failure. The text and notes layers are best
 * effort — several MB each, and each feeds only some facts and checks — so a
 * failure leaves `text: null` or `questions: null`.
 */
export async function loadBookPack(
  env: PackEnv,
  book: string,
  opts: { text?: boolean; questions?: boolean } = {},
): Promise<BkpResult<BookPack>> {
  const base = bkpBase(env)
  if (!base) return { ok: false, reason: "invalid" }
  if (!BOOK_CODE.test(book)) return { ok: false, reason: "not-found" }
  const manifest = await loadManifest(env, base)
  if (!manifest.ok) return manifest
  const { version, books } = manifest.value
  // Own keys only: "toString" or "__proto__" is not a book.
  const entry = Object.hasOwn(books, book) ? books[book] : undefined
  if (!entry || !["voices", "structure", "people"].every((layer) => entry.layers.includes(layer))) {
    return { ok: false, reason: "not-found" }
  }
  const [voices, structure, people] = await Promise.all([
    loadLayer(env, base, version, "voices", book),
    loadLayer(env, base, version, "structure", book),
    loadLayer(env, base, version, "people", book),
  ])
  if (!voices.ok) return voices
  if (!structure.ok) return structure
  if (!people.ok) return people
  const [text, questions] = await Promise.all([
    opts.text && entry.layers.includes("text")
      ? loadLayer(env, base, version, "text", book, (layer) => compactTextLayer(layer, impliedSubjectWords(people.value)))
      : null,
    opts.questions && entry.layers.includes("notes") ? loadLayer(env, base, version, "notes", book, questionsOf) : null,
  ])
  return {
    ok: true,
    value: {
      version,
      book,
      voices: voices.value,
      structure: structure.value,
      people: people.value,
      text: text?.ok ? text.value : null,
      questions: questions?.ok ? questions.value : null,
    },
  }
}

/** Test seam: forget the per-isolate memory, as a new isolate would. */
export function __resetBkpServerMemory(): void {
  manifestMemo = null
  memory.clear()
}
