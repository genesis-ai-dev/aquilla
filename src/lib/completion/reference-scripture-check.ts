// Does the draft actually quote the reference Bible? (AQU-1573)
//
// Injecting the reference verse into the prompt makes the right wording
// available; it does not make the model use it. The failure this check exists to
// catch is the one that drove the ticket: the draft reads fluently, the
// surrounding prose is right, and the quoted verse is a fresh translation an
// Arabic reader spots as wrong on sight. Nobody reviewing a 49-session
// curriculum catches that by eye on every paragraph.
//
// So: for each verse the project's reference Bible supplied, is that wording
// present in the draft? The comparison is deliberately LENIENT about surface
// form and strict about content words, because a quotation legitimately differs
// from a Bible edition in ways that are not errors — a sermon elides with "…",
// quotes half a verse, drops the trailing clause, or reflows punctuation. What
// it may NOT do is replace the verse's vocabulary.
//
// Constraints for anything added here — SAME contract as ./prompt-build.ts:
//   - NO `@/` path aliases, transitively.
//   - NO DOM, no `import.meta.env`, no storage access, no i18n.
//   - Pure functions only.

import type { ReferenceScriptureEntry } from "./prompt-build"

/** The id this check reports under, for `algorithmicChecks` overrides. */
export const REFERENCE_SCRIPTURE_CHECK_ID = "reference-scripture-mismatch"

/**
 * Share of the reference verse's content words that must appear in the draft
 * before the quotation counts as reproduced.
 *
 * 0.6 rather than something near 1.0 on purpose. A partial quotation is the
 * normal case in sermon prose — Chip Ingram quotes the clause he is preaching
 * on, not the whole verse — and a check that fires on every partial quotation
 * is a check a team turns off, after which it catches nothing at all. A draft
 * that retranslated the verse instead of copying it shares almost no content
 * words with the reference, so the signal is far from the threshold either way.
 */
export const REFERENCE_MATCH_THRESHOLD = 0.6

/**
 * Reference verses shorter than this (in content words) are not checked. A
 * two-word verse cannot distinguish "reproduced" from "coincidence", and
 * `wa-` style clitics make short-verse overlap noisy in exactly the languages
 * this feature serves.
 */
export const MIN_REFERENCE_WORDS = 4

export interface ReferenceScriptureFinding {
  checkId: typeof REFERENCE_SCRIPTURE_CHECK_ID
  /** Canonical ref of the verse that is not reproduced. */
  canonicalRef: string
  /** The citation as the source wrote it, e.g. "Isaiah 40:25". */
  citedAs: string
  versionId: string
  versionLabel: string
  /** The wording the draft was expected to carry. */
  expected: string
  /** Share of the reference's content words found in the draft (0–1). */
  overlap: number
}

/**
 * Normalize for comparison: fold case, drop punctuation and Arabic/Hebrew
 * diacritics, collapse whitespace. Marks (`\p{M}`) go rather than being folded
 * because a Bible edition is pointed and running prose usually is not — keeping
 * them would make every Arabic quotation look like a mismatch.
 */
export function normalizeForQuoteMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
}

/** Content words of a normalized string, de-duplicated. */
function contentWords(normalized: string): string[] {
  const words = normalized.split(" ").filter((w) => w.length > 1)
  return [...new Set(words)]
}

/**
 * Share of `reference`'s content words present in `draft`, 0–1. Returns 1 for a
 * reference with no content words so a degenerate verse never reports a
 * mismatch.
 */
export function quoteOverlap(draft: string, reference: string): number {
  const referenceWords = contentWords(normalizeForQuoteMatch(reference))
  if (!referenceWords.length) return 1
  const draftWords = new Set(contentWords(normalizeForQuoteMatch(draft)))
  const hits = referenceWords.filter((word) => draftWords.has(word)).length
  return hits / referenceWords.length
}

export interface CheckReferenceScriptureOptions {
  /** Override the overlap threshold (tests, future per-project tuning). */
  threshold?: number
}

/**
 * Flag every reference verse the draft fails to reproduce.
 *
 * An empty draft reports nothing: there is no translation yet to be wrong, and
 * the editor's other checks already speak to an empty target. Entries with no
 * reference text report nothing either — the resolver could not supply the
 * verse, which is its own reported condition, not a translator's mistake.
 */
export function checkReferenceScripture(
  draft: string | null | undefined,
  entries: readonly ReferenceScriptureEntry[] | undefined | null,
  options: CheckReferenceScriptureOptions = {},
): ReferenceScriptureFinding[] {
  const text = (draft ?? "").trim()
  if (!text) return []
  const threshold = options.threshold ?? REFERENCE_MATCH_THRESHOLD

  const findings: ReferenceScriptureFinding[] = []
  const seen = new Set<string>()
  for (const entry of entries ?? []) {
    const expected = entry.text.trim()
    if (!expected) continue
    if (contentWords(normalizeForQuoteMatch(expected)).length < MIN_REFERENCE_WORDS) continue
    const key = `${entry.versionId}|${entry.canonicalRef}`
    if (seen.has(key)) continue
    seen.add(key)

    const overlap = quoteOverlap(text, expected)
    if (overlap >= threshold) continue
    findings.push({
      checkId: REFERENCE_SCRIPTURE_CHECK_ID,
      canonicalRef: entry.canonicalRef,
      citedAs: entry.citedAs,
      versionId: entry.versionId,
      versionLabel: entry.versionLabel,
      expected,
      overlap,
    })
  }
  return findings
}
