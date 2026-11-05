---
name: qa-text-integrity
description: Find leftovers and corruption in plain text, with no markup assumed: stray code or formatting symbols, source-language text left in, copy-paste duplicates, empty or placeholder cells, and broken spacing. Replaces the USFM marker check.
pass: 1 Mechanical
verifier: Post-editor
---

# qa-text-integrity — Clean plain text

### Why

The text is published from plain text, so any leftover symbol or fragment shows up in the Scripture App. Copy-paste between Scripture Forge, documents and chat tools brings in code, formatting symbols and untranslated fragments.

### Procedure (sandbox code)

1. **Stray markup or code.** Check every cell for:
   * backslash codes (`\v`, `\p`, `\f` …)
   * HTML/XML tags (`<i>`, `</span>`, `&nbsp;`)
   * Markdown (`**`, `__`, `#` at line start, `[text](link)`)
   * curly-brace placeholders (`{0}`, `{name}`)
   * `@`, `|`, `^`, `~` (unless approved in `style/characters`)
   * URLs and email addresses
   * Each hit is Critical. Aquilla's built-in *Placeholder integrity* covers placeholders that are also in the source.
2. **Leftover source or draft text.** Report:
   * Words in the source text's script inside a target-script cell (Aquilla's *Untranslated words* also does this).
   * Runs of 4 or more consecutive words identical to the source verse, in a cell otherwise translated (Major).
   * Drafting notes left in the text: `TODO`, `???`, `xxx`, `[check]`, or brackets with source-language words (Critical).
3. **Duplicates.** Report:
   * Any sentence of 8 or more words that appears twice within one cell (Major).
   * A cell whose text appears in another, unrelated verse (Major, unless it is a parallel passage).
4. **Empty or placeholder cells.** Report cells containing only punctuation, only a number, or a single character, where the source verse has text (Critical).
5. **Spacing and line breaks.** Report:
   * Leading or trailing spaces, and double spaces (Minor; Aquilla's *Extra whitespace* overlaps, so report once).
   * Tabs, line breaks or paragraph breaks inside a cell, unless the verse is poetry and the team uses breaks (Query).
6. **Encoding.** Report:
   * Unicode replacement characters `�`, and mojibake patterns (`Ã©`, `â€™`) (Critical; overlaps with Aquilla's *Corrupted characters*).
   * Text that is not NFC-normalized (Minor). Propose normalization as one batch fix.

### Output

Use the findings table from `qa-run-book`. Group identical leftovers into one row (e.g. "`<i>` in 23 cells", with the references).

### Do not

* Remove anything automatically, except normalization approved as a batch by the post-editor.
