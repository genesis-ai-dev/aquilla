# 0018 — Example retrieval and confidence compare text by character n-grams

*Decided and recorded 2026-11-23 with AQU-2727. Project search, which had
the same cause, is [0017](0017-search-matches-words-or-text-by-script.md).*

## Context

Example retrieval (the few-shot examples the AI drafts from) is the AD-13
branching search: given a verse V, take the cell most like V, remove from V
what that cell shares with it, search again for the cell most like what is
left, and repeat until nothing of V is left. "What it shares" needs a unit.
Since the search was ported in on 2026-05-22 that unit was a word, cut at
spaces, and health confidence used words too.

A word is the wrong unit in two kinds of script:

- Chinese, Japanese, Thai, Burmese, Lao, Khmer and Tibetan put no space
  between words. A whole verse was one "word", so it matched nothing unless
  another verse was identical.
- Korean writes a noun joined to its particle, so `하나님이` and `하나님` were
  different words. The retrieval tokenizer also dropped combining marks, which
  cut Devanagari and Burmese words apart at every vowel sign.

## Decision

The unit is a character n-gram, cut by
`sync-worker/src/lib/text/char-ngrams.ts::forEachNgram` from text normalized by
`sync-worker/src/lib/text/char-ngrams.ts::normalizeForNgrams` (NFC, lowercased,
final sigma folded, anything that is not a letter, mark or digit collapsed to
one space, a space of padding on each side). The window is three characters,
or two where it touches a Han, Hiragana, Katakana or Hangul character: one of
those carries what two or three letters carry elsewhere, and a trigram there
spans a word, so `銅器` would never match inside `一切銅器皿`. Which length a
window gets depends only on the characters in it, so a query and a cell always
cut the same text the same way. Nothing else in the code knows what a word or a
script is.

`sync-worker/src/lib/branching-search/algorithm.ts::branchingSearch` covers V
by n-grams. Each step scores every unpicked cell against the n-grams of V that
still hold an uncovered character (Okapi BM25, boosted by the fraction of those
n-grams the cell has), picks the best, and marks every character of every
n-gram it shares as covered. The whole overlap is removed, not one contiguous
run of it. The loop stops when V is covered, nothing scores, or `topK` cells
are picked; with slots still open it starts again on the whole of V, without
the cells already picked.

`sync-worker/src/lib/confidence/lexical-confidence.ts::confidenceTerms` is the
same n-gram set, so `lexicalConfidence` and `lexicalSimilarity` score coverage
and Jaccard over n-grams instead of words.

## Consequences

- Provenance (which part of V each example covered) is quoted from V as typed,
  one string per covered stretch, not a list of lowercased words.
- Scores move. Two unrelated English verses share common n-grams (` th`, `the`,
  `and`) more often than they share words, so word-coverage numbers and
  n-gram-coverage numbers are not comparable. Health is relative to the
  project, but a threshold tuned on the old numbers needs looking at again.
- The corpus is still read whole per request. On the 30,959 verses of the
  World English Bible a query takes about as long as the word version did
  (about 0.8 s per query in a cloud test container), and a Thai Bible is faster. Cells that share no
  n-gram with V are dropped before the loop, and each step walks only the
  posting lists of what is left of V.
- `begin` now finds `beginning`, and inflected forms in spaced languages give
  partial credit.

## Not covered yet

- Health's neighbours (which cells it compares against) still come from the
  word index in `sync-worker/src/events/scoped-search.ts`, so in the scripts
  above health finds few neighbours to score, however well it scores them.
  That lookup needs n-gram retrieval too (Postgres `pg_trgm`, or the same
  in-memory scorer).
- The cross-language similarity route
  (`sync-worker/src/external/similar-route.ts`) re-scores with
  `lexicalSimilarity` but also gets its candidates from the word index.
