/**
 * file-genre.ts — per-file genre assignment (AQU-934 phase 3b).
 *
 * Genre was previously derivable ONLY from a USFM book code
 * (src/lib/scripture/book-genres.ts), so a genre-scoped style rule could never
 * reach a non-scripture document and a scripture book could never be
 * reclassified. This module adds the human-set (optionally model-suggested)
 * layer: `ProjectWideSettings.fileGenres` maps fileId → genre id, an explicit
 * assignment WINS over the derived book genre, and the resolved value is what
 * feeds the `genre` coordinate in the applicability ladder — so classifying one
 * document propagates every genre-scoped rule to all of its cells.
 *
 * Vocabulary: the eight scripture genres are imported verbatim from
 * `book-genres.ts` (one taxonomy, never two), plus four document-only members
 * that no book maps to and that the scripture taxonomy genuinely lacks —
 * see DOCUMENT_GENRES.
 *
 * The suggestion path is a hint, never a decision: `suggestFileGenres` returns
 * a map for a human to confirm, exactly like extracted style-rule candidates.
 */

import { complete } from "@/lib/completion/completion-service"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CompletionSettings } from "@/lib/parsers/types"
import { BOOK_GENRES, bookGenre, type BookGenre } from "@/lib/scripture/book-genres"
import type { UsageCallback } from "./rule-suggester"

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Genres a document can carry that no canonical book maps to. Added because a
 * canon-slot taxonomy cannot label the project's non-scripture material:
 *   - narrative  a story that is not the OT historical books (folk tale,
 *                testimony, dramatized retelling) — "history" reads as a canon
 *                slot and would mislabel them.
 *   - teaching   expository/instructional prose (lesson, sermon, study guide,
 *                manual); the scripture set covers letters but not didactics.
 *   - dialogue   turn-taking speech (script, subtitle track, interview) — the
 *                workspace's own subtitle/dubbing content class, where register
 *                per speaker drives style.
 *   - reference  apparatus rather than prose (glossary, translation notes,
 *                question sets, front matter) — terse and consistency-bound,
 *                unlike every literary genre above.
 */
export const DOCUMENT_GENRES = ["narrative", "teaching", "dialogue", "reference"] as const

export type DocumentGenre = (typeof DOCUMENT_GENRES)[number]

/** Every genre a file may be assigned: the scripture set plus DOCUMENT_GENRES. */
export type FileGenre = BookGenre | DocumentGenre

/** Ordered picker vocabulary — scripture genres first, in book-genres order. */
export const FILE_GENRES: readonly FileGenre[] = [...BOOK_GENRES, ...DOCUMENT_GENRES]

/**
 * `ProjectWideSettings.fileGenres`: fileId → genre id. Only files a human (or
 * a confirmed suggestion) classified appear; everything else derives.
 */
export type FileGenreAssignments = Readonly<Record<string, string>>

/** Exact membership test for a stored/derived genre id. */
export function isFileGenre(value: unknown): value is FileGenre {
  return typeof value === "string" && (FILE_GENRES as readonly string[]).includes(value)
}

/** Case/whitespace-tolerant read of an untrusted genre id; undefined = unknown. */
export function normalizeFileGenre(value: unknown): FileGenre | undefined {
  if (typeof value !== "string") return undefined
  const id = value.trim().toLowerCase()
  return isFileGenre(id) ? id : undefined
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Where a file's effective genre came from. */
export type FileGenreSource = "assigned" | "derived" | "none"

export interface ResolvedFileGenre {
  genre: FileGenre | undefined
  source: FileGenreSource
}

/**
 * The genre in force for a file. An explicit assignment wins over the genre
 * derived from the book code; an unknown/blank assignment is ignored (the file
 * falls back to derived), so a stale id in the settings blob can never blank
 * out a scripture book's genre.
 */
export function resolveFileGenre(
  fileId: string,
  bookCode: string | undefined,
  assignments: FileGenreAssignments | null | undefined,
): FileGenre | undefined {
  return describeFileGenre(fileId, bookCode, assignments).genre
}

/** {@link resolveFileGenre} plus the provenance the UI needs to label a row. */
export function describeFileGenre(
  fileId: string,
  bookCode: string | undefined,
  assignments: FileGenreAssignments | null | undefined,
): ResolvedFileGenre {
  const assigned = normalizeFileGenre(assignments?.[fileId])
  if (assigned) return { genre: assigned, source: "assigned" }
  const derived = bookGenre(bookCode ?? "")
  return derived ? { genre: derived, source: "derived" } : { genre: undefined, source: "none" }
}

/**
 * Assign (or, with `null`, clear) one file's genre. Returns a NEW map — the
 * settings key is replaced wholesale, so callers always send the full object.
 */
export function setFileGenre(
  assignments: FileGenreAssignments | null | undefined,
  fileId: string,
  genre: FileGenre | null,
): Record<string, string> {
  const next: Record<string, string> = { ...(assignments ?? {}) }
  if (genre === null) delete next[fileId]
  else next[fileId] = genre
  return next
}

/** Fold confirmed suggestions into the stored map (suggestions win on overlap). */
export function mergeFileGenres(
  assignments: FileGenreAssignments | null | undefined,
  suggestions: Readonly<Record<string, FileGenre>>,
): Record<string, string> {
  return { ...(assignments ?? {}), ...suggestions }
}

// ── Suggestion ──────────────────────────────────────────────────────────────

/** One file offered to the classifier. `sample` may be empty (name-only). */
export interface FileGenreSample {
  fileId: string
  name: string
  sample: string
}

/** Bounds keeping the single classification call small on a 66-book project. */
const MAX_FILES = 80
const MAX_SAMPLE_CHARS = 240
const MAX_OUTPUT_TOKENS = 1024

const CLASSIFY_SYSTEM_PROMPT = `You classify the documents of a translation project by literary genre, so that genre-scoped style rules reach the right documents.

Choose ONE genre id per document from this list, and never invent another:
- law: commands, statutes, covenant stipulations
- history: a record of past events — chronicles, annals, official accounts
- wisdom: proverbs, aphorisms, reflective instruction on how to live
- poetry: verse — parallel lines, imagery, song, lament
- prophecy: oracles and messages delivered on a deity's behalf
- gospel: an account of the life and teaching of Jesus
- epistle: a letter addressed to a person or a community
- apocalyptic: symbolic vision literature about the end of an age
- narrative: any other story or account — folk tale, testimony, retelling
- teaching: expository or instructional material — lessons, sermons, study guides, manuals
- dialogue: turn-taking speech — scripts, subtitles, interviews, drama
- reference: apparatus rather than prose — glossaries, notes, question sets, front matter

Output ONLY a JSON array of objects with this exact shape:
[{ "fileId": "the id given for the document", "genre": "one id from the list" }]

Rules:
- Copy each fileId back exactly as given.
- Judge from the sample text first and the document name second.
- OMIT a document entirely when its genre is not clear — a missing entry is better than a guess.
- No markdown, no code fences, no commentary. An empty array ([]) is a valid answer.`

/** Collapse whitespace and clip a sample to its budget. */
function trimSample(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ")
  return collapsed.length <= MAX_SAMPLE_CHARS ? collapsed : `${collapsed.slice(0, MAX_SAMPLE_CHARS)}…`
}

function buildClassifyPrompt(files: readonly FileGenreSample[]): string {
  return files
    .slice(0, MAX_FILES)
    .map((file) => {
      const sample = trimSample(file.sample ?? "")
      return `fileId: ${file.fileId}\nname: ${file.name}\nsample: ${sample || "(none)"}`
    })
    .join("\n\n")
}

/**
 * Parse a raw completion into `fileId → genre`. Robust to code fences and
 * prose wrappers (everything outside the outermost [] is ignored). Entries with
 * a non-string fileId/genre, an unknown genre id, or — when `knownFileIds` is
 * given — an id that is not this project's are dropped. The first entry for a
 * file wins, so a self-contradicting answer cannot flip a value silently.
 */
export function parseFileGenreSuggestions(
  raw: string,
  knownFileIds?: readonly string[],
): Record<string, FileGenre> {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return {}
  }
  if (!Array.isArray(parsed)) return {}

  const allowed = knownFileIds ? new Set(knownFileIds) : null
  const out: Record<string, FileGenre> = {}
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (typeof record.fileId !== "string") continue
    const fileId = record.fileId.trim()
    if (!fileId || (allowed && !allowed.has(fileId))) continue
    if (fileId in out) continue
    const genre = normalizeFileGenre(record.genre)
    if (!genre) continue
    out[fileId] = genre
  }
  return out
}

export interface FileGenreSuggestionInput {
  /** Files to classify — normally only those with no explicit assignment. */
  files: readonly FileGenreSample[]
  settings: CompletionSettings
  session?: FrontierSession | null
  signal?: AbortSignal
  onLlmCall?: UsageCallback
}

/**
 * Classify a batch of files in ONE completion. Returns `fileId → genre` for the
 * files the model was confident about — the caller shows them for confirmation
 * and only then writes `fileGenres` (model output is never auto-saved).
 * Completion errors propagate; an empty batch never calls the model.
 */
export async function suggestFileGenres(
  input: FileGenreSuggestionInput,
): Promise<Record<string, FileGenre>> {
  const files = input.files.slice(0, MAX_FILES)
  if (files.length === 0) return {}

  const raw = await complete({
    settings: {
      ...input.settings,
      maxTokens: Math.min(input.settings.maxTokens, MAX_OUTPUT_TOKENS),
      temperature: 0.1,
    },
    session: input.session ?? null,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      { role: "user", content: `Classify these documents:\n\n${buildClassifyPrompt(files)}` },
    ],
    signal: input.signal,
  })
  input.onLlmCall?.({
    kind: "file-genre-suggest",
    model: input.settings.model,
    provider: input.settings.provider || "frontier",
  })

  return parseFileGenreSuggestions(raw, files.map((f) => f.fileId))
}
