/**
 * rule-extractor.ts — AQU-196: Two-pass LLM extraction from unstructured documents.
 *
 * Pass 1 (fast model): Extract raw candidate observations/rules as strings.
 * Pass 2 (stronger model): Convert each candidate into a structured TranslationRule draft.
 *
 * Mirrors the pattern from rule-suggester.ts.
 *
 * AQU-466: hardened for real organisation style guides. The path had only ever
 * been exercised on short hand-written samples, where pass 1 comfortably fits
 * one request. A real guide is tens of pages, and three things broke on it:
 *   1. The whole document went to pass 1 in a single call under a 2048-token
 *      output cap, so the candidate array came back cut off mid-array — and the
 *      strict `JSON.parse` then yielded ZERO rules with no error at all. The
 *      document is now chunked (`chunkDocument`) and a truncated array is
 *      salvaged down to the candidates it did complete.
 *   2. Long guides restate the same convention in several sections, so
 *      chunking multiplies duplicates — candidates are now de-duplicated.
 *   3. Pass 2 patterns were accepted as any string, so a regex the model got
 *      wrong became a rule that silently never fires (rule-engine `compile()`
 *      caches the failed compile as null). Patterns must now compile.
 */

import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { RuleSuggestion } from "./rule-suggester"
import type { UsageCallback } from "./rule-suggester"
import { t } from "@/lib/i18n/standalone"

/** Max input size in bytes (~200 KB of UTF-8 text). */
export const MAX_INPUT_BYTES = 200 * 1024

export function checkInputSize(text: string): { ok: true } | { ok: false; message: string } {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_INPUT_BYTES) {
    const kb = Math.round(bytes / 1024)
    return {
      ok: false,
      message: t("rules.importDialog.documentTooLarge", { kb }),
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Document chunking (AQU-466)
// ---------------------------------------------------------------------------

/**
 * Byte budget for one pass-1 request. A 200 KB guide is ~50k tokens, which
 * neither fits a fast model's context nor can be summarised under the 2048
 * output-token cap pass 1 runs with. ~24 KB (~6k tokens) leaves room for the
 * prompt and for a candidate list long enough to cover the chunk.
 */
export const PASS1_CHUNK_BYTES = 24 * 1024

const encoder = new TextEncoder()
const byteLength = (s: string): number => encoder.encode(s).length

/**
 * Split a document into pass-1 sized chunks, cutting on line boundaries so a
 * rule is not sliced in half. Style guides converted from PDF/DOCX sometimes
 * arrive as one enormous line, so an oversize line is split on whitespace and,
 * failing that, on code-point boundaries.
 */
export function chunkDocument(text: string, maxBytes: number = PASS1_CHUNK_BYTES): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (byteLength(trimmed) <= maxBytes) return [trimmed]

  const chunks: string[] = []
  let current = ""
  let currentBytes = 0

  for (const line of trimmed.split(/\r?\n/)) {
    for (const piece of splitOversizeLine(line, maxBytes)) {
      const pieceBytes = byteLength(piece) + 1 // + the newline we re-add
      if (currentBytes > 0 && currentBytes + pieceBytes > maxBytes) {
        if (current.trim()) chunks.push(current.trim())
        current = ""
        currentBytes = 0
      }
      current += piece + "\n"
      currentBytes += pieceBytes
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

function splitOversizeLine(line: string, maxBytes: number): string[] {
  if (byteLength(line) <= maxBytes) return [line]

  const pieces: string[] = []
  let buf = ""
  let bufBytes = 0

  // Keep the separators so whitespace inside the line survives the round trip.
  for (const word of line.split(/(\s+)/)) {
    if (!word) continue
    const wordBytes = byteLength(word)
    if (wordBytes > maxBytes) {
      // A single token larger than the budget (base64 blob, minified table).
      if (buf) {
        pieces.push(buf)
        buf = ""
        bufBytes = 0
      }
      pieces.push(...splitByCodePoint(word, maxBytes))
      continue
    }
    if (bufBytes > 0 && bufBytes + wordBytes > maxBytes) {
      pieces.push(buf)
      buf = ""
      bufBytes = 0
    }
    buf += word
    bufBytes += wordBytes
  }
  if (buf) pieces.push(buf)
  return pieces
}

function splitByCodePoint(text: string, maxBytes: number): string[] {
  const pieces: string[] = []
  let buf = ""
  let bufBytes = 0
  // Iterating a string yields code points, so surrogate pairs stay intact.
  for (const ch of text) {
    const chBytes = byteLength(ch)
    if (bufBytes > 0 && bufBytes + chBytes > maxBytes) {
      pieces.push(buf)
      buf = ""
      bufBytes = 0
    }
    buf += ch
    bufBytes += chBytes
  }
  if (buf) pieces.push(buf)
  return pieces
}

/**
 * Normalised key for de-duplicating candidates. Long guides restate the same
 * convention across sections (and each chunk is extracted independently), so
 * without this a real guide yields the same rule five or six times — and each
 * duplicate costs a pass-2 call.
 */
export function candidateKey(candidate: string): string {
  return candidate
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?"'`]+$/g, "")
    .trim()
}

// ---------------------------------------------------------------------------
// Pass 1 — extract raw candidates
// ---------------------------------------------------------------------------

const PASS1_SYSTEM_PROMPT = `You are an expert translation quality analyst reading a style guide, glossary, or translation guidelines document.

Extract every rule, convention, constraint, or recommendation mentioned in the document that could be verified in a translated text. Output them as a JSON array of plain-English strings — one per observation.

Examples of good observations:
- "Numbers must be preserved exactly as in the source"
- "The term 'church' must be translated as 'ekklesia'"
- "Sentences must not end with ellipsis"

Rules:
- Only include things that could be CHECKED by looking at the translation text
- Do NOT include vague instructions about tone, creativity, or meaning accuracy
- Output ONLY a valid JSON array of strings, no markdown, no code fences, no explanation
- If nothing checkable is found, return []`

/**
 * AQU-1254: what pass 1 actually produced. The candidate list alone cannot tell
 * "this document has no checkable rules" apart from "the model's answer was cut
 * off mid-array" — both arrive as a short (or empty) list — and the dialog has
 * to say something different in each case.
 */
export interface CandidateExtraction {
  candidates: string[]
  /** Pass-1 chunks the document was split into. */
  chunkCount: number
  /** Chunks whose pass-1 response was not a complete JSON array. */
  truncatedChunks: number
}

/**
 * Run pass 1 over the whole document, one request per chunk, merging and
 * de-duplicating the candidates. `onChunk` reports (done, total) so the dialog
 * can show progress through a long guide instead of appearing to hang.
 */
export async function extractCandidates(
  docText: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
  onChunk?: (done: number, total: number) => void,
): Promise<CandidateExtraction> {
  const chunks = chunkDocument(docText)
  const seen = new Set<string>()
  const candidates: string[] = []
  let truncatedChunks = 0

  for (let i = 0; i < chunks.length; i++) {
    const userMessage = `Extract all verifiable translation rules and conventions from this document:\n\n${chunks[i]}`

    const response = await complete({
      settings: {
        ...settings,
        // Pass 1: fast model, short output
        maxTokens: Math.min(settings.maxTokens, 2048),
        temperature: 0.1,
      },
      session,
      messages: [
        { role: "system", content: PASS1_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    })

    onLlmCall?.({
      kind: "rule-extract-pass1",
      model: settings.model,
      provider: settings.provider || "frontier",
    })

    const parsed = parseCandidatesDetailed(response)
    if (parsed.truncated) truncatedChunks++

    for (const candidate of parsed.candidates) {
      const key = candidateKey(candidate)
      if (!key || seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
    }

    onChunk?.(i + 1, chunks.length)
  }

  return { candidates, chunkCount: chunks.length, truncatedChunks }
}

export interface ParsedCandidates {
  candidates: string[]
  /**
   * The response was not a complete JSON array, so anything the model wrote
   * after the cut is gone. True even when `candidates` is non-empty: the
   * entries before the cut survive, the ones after it never arrived.
   */
  truncated: boolean
}

export function parseCandidates(raw: string): string[] {
  return parseCandidatesDetailed(raw).candidates
}

/**
 * AQU-1254: `parseCandidates` with the reason the list came out the length it
 * did. A caller that only sees `[]` cannot distinguish a document with nothing
 * checkable in it from an answer that was cut off before the first complete
 * entry, and telling a user their style guide has "no rules" when extraction
 * was actually truncated is the bug this pins.
 */
export function parseCandidatesDetailed(raw: string): ParsedCandidates {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("[")
  // No array at all: the model answered with prose or nothing. Not a cut-off
  // array — there is no evidence any candidate was lost.
  if (start === -1) return { candidates: [], truncated: false }

  const end = cleaned.lastIndexOf("]")
  if (end > start) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        return {
          candidates: parsed
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((x) => x.trim()),
          truncated: false,
        }
      }
    } catch {
      // Malformed — fall through and salvage what completed.
    }
  }

  // AQU-466: pass 1 hitting its output cap on a long guide leaves the array
  // unterminated. Strict parsing returned [] — a real style guide imported as
  // zero rules, with no error to explain it. Salvage the complete entries.
  return { candidates: salvageStrings(cleaned.slice(start)), truncated: true }
}

/**
 * Pull every COMPLETE JSON string literal out of a truncated array, stopping at
 * the first unterminated one (that entry was cut mid-word and would import a
 * half-sentence rule).
 */
function salvageStrings(text: string): string[] {
  const out: string[] = []
  let i = 0

  while (i < text.length) {
    if (text[i] !== '"') {
      i++
      continue
    }
    let j = i + 1
    let closed = false
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2
        continue
      }
      if (text[j] === '"') {
        closed = true
        break
      }
      j++
    }
    if (!closed) break // truncated mid-string — everything after is unusable

    try {
      const value: unknown = JSON.parse(text.slice(i, j + 1))
      if (typeof value === "string" && value.trim()) out.push(value.trim())
    } catch {
      // Not a well-formed literal; skip it.
    }
    i = j + 1
  }

  return out
}

// ---------------------------------------------------------------------------
// Pass 2 — structure each candidate
// ---------------------------------------------------------------------------

const PASS2_SYSTEM_PROMPT = `You are an expert translation QA analyst. You will receive a plain-English description of a translation rule or constraint. Convert it into a structured rule JSON object.

The output must be a single JSON object with this exact shape:
{
  "name": "Short descriptive name (under 60 chars)",
  "description": "One-sentence explanation of why this matters",
  "severity": "major" | "minor",
  "check": { /* one of three types below */ }
}

The check field must be ONE of:
1. { "type": "source-target-match", "pattern": "regex-string" }
   Use when the same pattern must appear in both source AND target.

2. { "type": "source-requires-target", "sourcePattern": "regex", "targetPattern": "regex" }
   Use when: IF source matches sourcePattern THEN target must match targetPattern.

3. { "type": "target-forbids", "targetPattern": "regex" }
   Use when: target must NOT contain targetPattern.

Severity guide:
- "major" = numbers, URLs, proper nouns, required terminology, placeholders
- "minor" = style, punctuation, capitalization preferences

Use JavaScript regex syntax. Escape backslashes in JSON strings (\\\\d for \\d).
If the rule cannot be expressed as a regex check, output: null

Output ONLY valid JSON — a single object or null. No markdown, no explanation.`

export async function structureCandidate(
  candidate: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<RuleSuggestion | null> {
  const response = await complete({
    settings: {
      ...settings,
      // Pass 2: stronger model, controlled output
      maxTokens: Math.min(settings.maxTokens, 512),
      temperature: 0.1,
    },
    session,
    messages: [
      { role: "system", content: PASS2_SYSTEM_PROMPT },
      { role: "user", content: `Convert this rule to structured JSON:\n\n${candidate}` },
    ],
  })

  onLlmCall?.({
    kind: "rule-extract-pass2",
    model: settings.model,
    provider: settings.provider || "frontier",
  })

  return parseStructuredRule(response)
}

export function parseStructuredRule(raw: string): RuleSuggestion | null {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  if (cleaned === "null") return null
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    if (!isValidRuleSuggestion(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * AQU-466: a pattern is only usable if it actually compiles. The rule engine
 * caches a failed compile as null and skips the rule, so an invalid regex from
 * pass 2 used to import as a rule that looks enabled and never fires. An empty
 * pattern is rejected too — as a `target-forbids` it flags every single cell.
 */
function isUsablePattern(p: unknown): p is string {
  if (typeof p !== "string" || !p.trim()) return false
  try {
    new RegExp(p)
    return true
  } catch {
    return false
  }
}

function isValidRuleSuggestion(s: unknown): s is RuleSuggestion {
  if (!s || typeof s !== "object") return false
  const obj = s as Record<string, unknown>
  if (typeof obj.name !== "string" || !obj.name) return false
  if (typeof obj.description !== "string") return false
  if (obj.severity !== "major" && obj.severity !== "minor") return false
  const check = obj.check as Record<string, unknown> | undefined
  if (!check || typeof check !== "object") return false
  if (check.type === "source-target-match") return isUsablePattern(check.pattern)
  if (check.type === "target-forbids") return isUsablePattern(check.targetPattern)
  if (check.type === "source-requires-target") {
    return isUsablePattern(check.sourcePattern) && isUsablePattern(check.targetPattern)
  }
  return false
}

// ---------------------------------------------------------------------------
// Orchestrator — runs both passes, calls progress callback
// ---------------------------------------------------------------------------

export interface ExtractionProgress {
  phase: "extracting" | "structuring"
  candidateCount: number
  structuredCount: number
  /** AQU-466: pass-1 chunks for this document (absent until the first completes). */
  chunkCount?: number
  chunksDone?: number
}

/**
 * AQU-1254: the rules plus how completely they were extracted. An empty `rules`
 * with `truncatedChunks > 0` is a cut-off answer, not an empty document, and
 * the two get different copy in the import dialog.
 */
export interface DocumentExtraction {
  rules: RuleSuggestion[]
  /** Pass-1 chunks the document was split into. */
  chunkCount: number
  /** Chunks whose pass-1 answer was cut off, losing the candidates after the cut. */
  truncatedChunks: number
}

export async function extractRulesFromDocument(
  docText: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onProgress?: (p: ExtractionProgress) => void,
  onLlmCall?: UsageCallback,
): Promise<DocumentExtraction> {
  // Pass 1 — one request per chunk of the document.
  onProgress?.({ phase: "extracting", candidateCount: 0, structuredCount: 0 })
  const { candidates, chunkCount, truncatedChunks } = await extractCandidates(
    docText,
    settings,
    session,
    onLlmCall,
    (chunksDone, total) => {
      onProgress?.({
        phase: "extracting",
        candidateCount: 0,
        structuredCount: 0,
        chunkCount: total,
        chunksDone,
      })
    },
  )
  onProgress?.({ phase: "structuring", candidateCount: candidates.length, structuredCount: 0 })

  // Pass 2 — structure each candidate sequentially, updating progress
  const results: RuleSuggestion[] = []
  for (let i = 0; i < candidates.length; i++) {
    const structured = await structureCandidate(candidates[i], settings, session, onLlmCall)
    if (structured) results.push(structured)
    onProgress?.({
      phase: "structuring",
      candidateCount: candidates.length,
      structuredCount: i + 1,
    })
  }

  return { rules: results, chunkCount, truncatedChunks }
}
