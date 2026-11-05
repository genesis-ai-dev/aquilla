---
name: qa-characters-punctuation
description: Check characters, punctuation, unmatched pairs and quotation levels in the scope against the verified baseline built from the approved books. Equivalent to the Paratext Characters, Punctuation, Unmatched Pairs and Quotations checks.
pass: 1 Mechanical
verifier: Proof-reader
---

# qa-characters-punctuation — Characters, punctuation, pairs, quotations

### Why

Keyboard defaults and copy-paste bring in wrong code points: a Latin full stop instead of the script's own, a hyphen instead of an en dash, straight quotes instead of curly. They look right on screen, but they break search, line-breaking and fonts. Nested speech also produces unbalanced or wrong-level quotes.

### Baseline (required)

* Memory notes `style/characters`, `style/punctuation` and `style/quotations`, verified through `qa-bootstrap-inventories`.
* If they are missing, stop and suggest running the bootstrap first. Never invent an approved set.

### Procedure (sandbox code)

1. **Characters not in the baseline.** List every character in the scope (after NFC) that isn't in `style/characters`: code point, name, count, references. Severity: Major; Critical if from another script or invisible.
2. **Mixed-script words.** Report any word mixing scripts (e.g. Cyrillic `о` inside a Latin word) as Critical.
3. **Spacing.** For each mark, compare its spacing before and after with the verified pattern. Report only deviations, grouped by pattern (Minor).
4. **Wrong code point.** Report a mark whose look-alike is the approved one (e.g. `'` where `’` is approved) as Major, with an autofix suggestion.
5. **Sentence end.** If the language uses end marks, check that a source verse ending in `.` `?` or `!` ends with the approved equivalent (Minor; overlaps with Aquilla's *End punctuation*, so report once).
6. **Unmatched pairs.** Check all approved pairs — `( )`, `[ ]`, quotation marks, and any script-specific pairs — within the cell and across consecutive cells, for speech spanning verses. Report Major.
7. **Quotation levels.** Check that nesting follows `style/quotations`, and that each quote opens and closes at the right level, across verse cells (Major).
8. **Abbreviations.** Report a token followed by `.` and a lowercase letter that isn't in the approved abbreviation list (Query).

### Output

Use the findings table from `qa-run-book`. Group identical issues into one row with the count and all references.

### Do not

* Decide a new mark or spacing pattern is correct. Raise a Query so the proof-reader can add it to the baseline.
