// Punctuation conventions per target language (AQU-1906).
//
// The built-in punctuation checks (End punctuation, Punctuation integrity) used
// to judge a translation by the SOURCE's marks alone: a Thai verse that ends
// with nothing was "unterminated", a Greek question that ends ";" "ended in the
// wrong mark", an Arabic ";" rendered "؛" was "missing". None of those is an
// error — they are the target language writing itself correctly.
//
// This table says, per language, which marks answer which source mark. It is
// ADDITIVE over `UNIVERSAL_PUNCTUATION` (the marks both checks already
// honoured), so a language entry only ever makes a check more permissive:
// nothing that passed before this file existed can start failing because of it.
//
// Commas are deliberately absent. No built-in check flags a comma today, so a
// comma column would be a shape nothing reads (see AQU-1906's note about where
// ETT's comma example most likely came from).
//
// Pure and dependency-free, with relative imports only and no DOM, so both
// workers can import it alongside ./language-profile.ts.
//
// Spec: aquilla-specs 05-user-stories/run-builtin-check.md and
// 04-features/checks-rules-and-living-memory.md ("Built-in checks judge the
// target by the target language's punctuation").

import { normalizeLanguageTag } from './language-normalize'

/**
 * The marks that answer each source mark in one language.
 *
 * `question` / `exclamation` / `statement` are TERMINAL marks, classified in
 * that order — a mark listed under two classes resolves to the first, so no
 * entry below lists one twice.
 *
 * `colon` / `semicolon` are the CLAUSE marks the Punctuation integrity check
 * looks for when the source uses ":" or ";".
 */
export interface PunctuationConventions {
  question: string[]
  exclamation: string[]
  statement: string[]
  colon: string[]
  semicolon: string[]
  /**
   * The language normally ends a sentence with NO mark (Thai, Lao, Khmer).
   * A target that ends with nothing then answers any source class.
   *
   * It does not silence the check: a target that DOES carry a terminal mark is
   * still compared by class, which is what keeps AQU-1906's second Thai
   * criterion true ("the translation ending '?' → still flagged").
   */
  noTerminalMark: boolean
}

/** What a caller may store in the Language profile's `punctuation` slot. */
export type PunctuationProfile = Partial<PunctuationConventions>

/**
 * The marks the two checks honoured before this file existed, and the floor
 * every resolved set is unioned with. Changing a list here changes behaviour
 * for EVERY project, language entry or not.
 */
export const UNIVERSAL_PUNCTUATION: Readonly<PunctuationConventions> = {
  question: ['?', '？', '؟'],
  exclamation: ['!', '！', '¡'],
  statement: ['.', '。', '…', '．'],
  colon: [':', '：'],
  semicolon: [';', '；'],
  noTerminalMark: false,
}

/**
 * Per-language additions, keyed by a lowercased BCP 47 subtag: the whole tag,
 * its primary subtag, or its script subtag (`deva`, `ethi`). A lane's code is
 * matched most-specific-first by {@link punctuationConventionsForLanguage}.
 *
 * Several languages are listed under both their two- and three-letter codes
 * because a lane's `langCode` override is whatever the user typed.
 */
const BY_SUBTAG: Readonly<Record<string, Readonly<PunctuationProfile>>> = {
  // ── Arabic script: mirrored question mark and semicolon ──────────────────
  ar: { question: ['؟'], semicolon: ['؛'] },
  ara: { question: ['؟'], semicolon: ['؛'] },
  fa: { question: ['؟'], semicolon: ['؛'] },
  fas: { question: ['؟'], semicolon: ['؛'] },
  ur: { question: ['؟'], semicolon: ['؛'], statement: ['۔'] },
  urd: { question: ['؟'], semicolon: ['؛'], statement: ['۔'] },
  ps: { question: ['؟'], semicolon: ['؛'] },
  ckb: { question: ['؟'], semicolon: ['؛'] },
  arab: { question: ['؟'], semicolon: ['؛'] },

  // ── Greek: ";" asks the question, "·" separates the clause ───────────────
  el: { question: [';'], semicolon: ['·'] },
  ell: { question: [';'], semicolon: ['·'] },
  gre: { question: [';'], semicolon: ['·'] },
  grc: { question: [';'], semicolon: ['·'] },

  // ── Devanagari: the danda ends the sentence ──────────────────────────────
  deva: { statement: ['।', '॥'] },
  hi: { statement: ['।', '॥'] },
  hin: { statement: ['।', '॥'] },
  mr: { statement: ['।', '॥'] },
  mar: { statement: ['।', '॥'] },
  ne: { statement: ['।', '॥'] },
  nep: { statement: ['।', '॥'] },
  sa: { statement: ['।', '॥'] },
  san: { statement: ['।', '॥'] },
  bn: { statement: ['।'] },
  ben: { statement: ['।'] },
  pa: { statement: ['।', '॥'] },
  pan: { statement: ['।', '॥'] },

  // ── Armenian: its own full stop, question and exclamation marks ──────────
  hy: { statement: ['։'], question: ['՞'], exclamation: ['՜'] },
  hye: { statement: ['։'], question: ['՞'], exclamation: ['՜'] },
  arm: { statement: ['։'], question: ['՞'], exclamation: ['՜'] },
  armn: { statement: ['։'], question: ['՞'], exclamation: ['՜'] },

  // ── Ethiopic: four-dot full stop, its own colon and semicolon ───────────
  ethi: { statement: ['።'], colon: ['፦', '፥'], semicolon: ['፤'] },
  am: { statement: ['።'], colon: ['፦', '፥'], semicolon: ['፤'] },
  amh: { statement: ['።'], colon: ['፦', '፥'], semicolon: ['፤'] },
  ti: { statement: ['።'], colon: ['፦', '፥'], semicolon: ['፤'] },
  tir: { statement: ['።'], colon: ['፦', '፥'], semicolon: ['፤'] },

  // ── Burmese: the sentence-final "။" ─────────────────────────────────────
  my: { statement: ['။'] },
  mya: { statement: ['။'] },
  bur: { statement: ['။'] },
  mymr: { statement: ['။'] },

  // ── CJK: the full-width forms, listed so the Rules row can name them ────
  zh: { question: ['？'], exclamation: ['！'], statement: ['。'], colon: ['：'], semicolon: ['；'] },
  zho: { question: ['？'], exclamation: ['！'], statement: ['。'], colon: ['：'], semicolon: ['；'] },
  chi: { question: ['？'], exclamation: ['！'], statement: ['。'], colon: ['：'], semicolon: ['；'] },
  yue: { question: ['？'], exclamation: ['！'], statement: ['。'], colon: ['：'], semicolon: ['；'] },
  ja: { question: ['？'], exclamation: ['！'], statement: ['。'], colon: ['：'], semicolon: ['；'] },
  jpn: { question: ['？'], exclamation: ['！'], statement: ['。'], colon: ['：'], semicolon: ['；'] },

  // ── No terminal mark: a sentence simply ends ─────────────────────────────
  th: { noTerminalMark: true },
  tha: { noTerminalMark: true },
  lo: { noTerminalMark: true },
  lao: { noTerminalMark: true },
  // Khmer is in AQU-1906's "no terminal mark" group, and the khan "។" is
  // nonetheless accepted so a translator who types one is not flagged either.
  km: { noTerminalMark: true, statement: ['។'] },
  khm: { noTerminalMark: true, statement: ['។'] },
}

const SCRIPT_SUBTAG = /^[a-z]{4}$/

/** Distinct entries, universal marks first so the common case reads first. */
function union(universal: readonly string[], added: readonly string[] | undefined): string[] {
  return added && added.length > 0 ? [...new Set([...universal, ...added])] : [...universal]
}

/** A language's (or a profile's) marks, laid over {@link UNIVERSAL_PUNCTUATION}. */
export function mergeWithUniversal(added: Readonly<PunctuationProfile>): PunctuationConventions {
  return {
    question: union(UNIVERSAL_PUNCTUATION.question, added.question),
    exclamation: union(UNIVERSAL_PUNCTUATION.exclamation, added.exclamation),
    statement: union(UNIVERSAL_PUNCTUATION.statement, added.statement),
    colon: union(UNIVERSAL_PUNCTUATION.colon, added.colon),
    semicolon: union(UNIVERSAL_PUNCTUATION.semicolon, added.semicolon),
    noTerminalMark: added.noTerminalMark === true,
  }
}

/**
 * The table entry for a lane's language, with the subtag that matched, or null
 * when the table says nothing about it.
 *
 * `language` is whatever the lane holds — a BCP 47 code ("th", "hi-Deva") or
 * the freeform label the user typed ("Thai"). Matched most-specific-first: the
 * whole tag, then its script subtag ("deva" in "hi-deva"), then its primary
 * subtag, then the canonical form `normalizeLanguageTag` gives a name or an
 * ISO 639-2/B alias ("Thai" and "gre" both land on an entry).
 */
export function punctuationConventionsForLanguage(
  language: string | null | undefined,
): { subtag: string; conventions: PunctuationConventions } | null {
  const found = entryForLanguage(language)
  return found ? { subtag: found.subtag, conventions: mergeWithUniversal(found.entry) } : null
}

function entryForLanguage(
  language: string | null | undefined,
): { subtag: string; entry: Readonly<PunctuationProfile> } | null {
  const tag = (language ?? '').trim().toLowerCase()
  if (!tag) return null
  const parts = tag.split(/[-_]/).filter((part) => part !== '')
  const candidates = [
    tag,
    ...parts.filter((part) => SCRIPT_SUBTAG.test(part)),
    parts[0] ?? '',
    normalizeLanguageTag(tag),
  ]
  for (const candidate of candidates) {
    const entry = candidate ? BY_SUBTAG[candidate] : undefined
    if (entry) return { subtag: candidate, entry }
  }
  return null
}

/**
 * The table's own answer for a language, in the shape the Language profile's
 * `punctuation` slot stores — what the settings card PRE-FILLS the slot with.
 *
 * Only the language's OWN marks, not the universal floor: storing them back
 * resolves to the same conventions the table would have given, and a lead
 * editing the row sees "؟" rather than every mark in the world.
 */
export function punctuationProfileForLanguage(
  language: string | null | undefined,
): PunctuationProfile | null {
  const found = entryForLanguage(language)
  if (!found) return null
  // A copy: the table is module state shared by every project on the page.
  return JSON.parse(JSON.stringify(found.entry)) as PunctuationProfile
}

/** Where a lane's conventions came from — what the Rules → Built-in checks row says. */
export type PunctuationOrigin =
  /** The project's Language profile fills the `punctuation` slot; it wins over the table. */
  | { kind: 'profile' }
  /** The table knows this language; `subtag` is the key that matched. */
  | { kind: 'language'; subtag: string }
  /** Nothing knows this lane's language — the checks stay source-relative, exactly as before AQU-1906. */
  | { kind: 'source-relative' }

export interface ResolvedPunctuation {
  /**
   * The marks to judge the target by, or null to keep the pre-AQU-1906
   * source-relative behaviour (the check functions' own default sets).
   */
  conventions: PunctuationConventions | null
  origin: PunctuationOrigin
}

/**
 * Resolve one lane's punctuation conventions: the Language profile's slot when
 * it is filled, else the table entry for the lane's language, else nothing.
 *
 * A filled profile wins WHOLE — the table entry is not consulted and not
 * merged in, so a project lead who answers the slot gets exactly what they
 * answered (over the universal floor), not a blend with a guess.
 */
export function resolvePunctuation(input: {
  /** The lane's language code, or the label the user typed — either resolves. */
  language?: string | null
  profile?: Readonly<PunctuationProfile> | null
}): ResolvedPunctuation {
  if (input.profile && Object.keys(input.profile).length > 0) {
    return { conventions: mergeWithUniversal(input.profile), origin: { kind: 'profile' } }
  }
  const entry = punctuationConventionsForLanguage(input.language)
  if (entry) return { conventions: entry.conventions, origin: { kind: 'language', subtag: entry.subtag } }
  return { conventions: null, origin: { kind: 'source-relative' } }
}
