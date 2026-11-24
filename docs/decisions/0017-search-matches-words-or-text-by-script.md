# 0017 — Search matches words, except in scripts where it has to match text

*Decided and recorded 2026-11-23 with AQU-2731, after a partner searching
2 Kings for 器皿 got no results. Retrieval and confidence, which share the
cause, are AQU-2727. The 50-result limit is AQU-2732.*

## Context

Project search is Postgres full-text over `cells.value_tsv`, built with the
`simple` configuration. That index holds words: text cut at spaces and
punctuation. Checked on the dev database (Postgres 18.6, `C.UTF-8`):

| Text | What the index holds | A search for |
| --- | --- | --- |
| `並所用的一切銅器皿，` | `並所用的一切銅器皿`, one entry | `器皿` finds nothing |
| a whole Thai verse | the verse, one entry | any word in it finds nothing |
| `태초에 하나님이 천지를` | `하나님이` | `하나님` finds nothing |
| `In the beginning God` | `god` | `God` finds it |

Two different causes. Chinese, Japanese, Thai, Burmese, Lao, Khmer and
Tibetan put no space between words, so there are no words to index. Korean
is spaced, but a noun is written joined to its particle and a verb to its
ending, so the index holds forms nobody types.

Both fail in a way that hides the failure. `、器皿、` and a bare `하나님` do
get indexed, so the search returns those few cells and the list looks
complete.

## Decision

`db/shared/find-pattern.ts::needsSubstringSearch` names the scripts the word
index cannot search. A default search (no match-case, whole-word or regexp
toggle) whose query has one character from them is answered by
`sync-worker/src/events/scoped-search.ts::queryScopedText`; every other
query stays on the word index, in
`sync-worker/src/events/scoped-search.ts::queryScopedSearch`, with the same
SQL as before.

The text path keeps the word search's contract, reading "word" as "what the
person typed between spaces": every piece must be in the cell, in any order,
ignoring case, matched as text. The exact-phrase search
(`sync-worker/src/events/scoped-search.ts::queryScopedExact`, parallel
passages) takes the whole query as one piece.

Order is relevance, best first:

1. cells holding the whole query exactly as typed (queries of several words);
2. more occurrences of the typed pieces, summed;
3. reading order: file, then place in the file.

Step 3 is what most of the list looks like, because most cells say a term
once. It also makes the order the same on every request, which the word
index's order is not for equal scores.

"Place in the file" is the cell's `sequence_index` where the importer wrote
one, then the chapter and verse of its reference, compared as numbers. The
second key is not a nicety: a project migrated from Codex has no
`sequence_index` on any cell, and walking one in the browser showed 2 Kings
coming back 4:3, 12:13, 4:4, which is cell-id order.

The route is chosen by script, never by "the word index returned nothing".
A fallback on an empty result would miss exactly the case above where the
index returns a few cells.

## Consequences

- Adding a script is one name in the list in
  `db/shared/find-pattern.ts`, plus a row in
  `sync-worker/src/__tests__/search-text-scripts.test.ts`.
- The text path reads every cell of the project (or the file) to find
  matches. That is the cost the match-case search already pays. It cannot use
  the index.
- `rank` means different things on the two paths: a fraction from `ts_rank`,
  or a whole-number count. Higher is better on both. Clients show results in
  the order sent and do not compare ranks across searches.
- The snippet comes from
  `db/shared/find-pattern.ts::markedSnippetOfAll`, not `ts_headline`.
- A Korean or Chinese query matches inside longer words. That is the point,
  and it also means `하나` finds `하나님`.
- The same test file pins the other direction: English, French, Spanish,
  Russian, Greek, Hebrew, Arabic and Amharic queries must not match inside a
  word, so a script that slips onto the text path fails there.

## Not covered yet

- Partial words in scripts that stay on the word index. `begin` does not
  find `beginning`, and languages that build long words in Latin or Cyrillic
  letters (Turkish, Finnish, Swahili) have Korean's problem with no script to
  detect it by.
- The whole-word toggle. It means nothing in a script with no word
  boundaries and returns nothing there.
- Text stored decomposed while the query is typed composed, or the reverse.
  Neither path normalizes.
- AI example retrieval and health confidence split text the same way and
  were wrong for the same scripts (AQU-2727). They now compare character
  n-grams: [0018](0018-retrieval-covers-text-by-character-ngrams.md).
- Order across files in a project-wide text search is by file id, not by the
  order files appear in the sidebar.
- The editor's own order is the anchor chain
  (`sync-worker/src/events/cells-read-route.ts::walkAnchorChain`), which SQL
  cannot sort by without walking the file. A line moved by hand keeps its old
  place in search order, and a file with neither a sequence index nor verse
  references falls back to cell id.
