---
name: qa-notes-headings-names
description: Check footnotes, cross-references, section headings and book names as they appear in Aquilla, with no USFM assumed, against the verified conventions and the source text. Replaces the Paratext Footnote Quotes and References checks.
pass: 5 Publish
verifier: Proof-reader (the mentor decides any new convention)
---

# qa-notes-headings-names — Notes, references, headings, book names

### Why

Late edits to a verse often leave its footnote quoting the old wording. Book names and references in notes must match the project's own book names, or navigation and links in the Scripture App break.

### How the text is read

* Read notes and headings as Aquilla shows them: separate cells, or note text attached to a verse cell.
* Don't depend on markup codes. If any are present, ignore them here; `qa-text-integrity` reports them.
* If the project has no notes or headings, skip those parts and say so.

### Baseline

* The book-names list (full name, short name, abbreviation), taken from the project settings or a verified list in memory under `glossary/book-names`. If none exists, build it from the approved books and ask the proof-reader to verify it.
* The footnote and heading style in `style/conventions`.

### Procedure (sandbox code)

#### Notes and cross-references

1. **Quoted words:** any word or phrase a note quotes from its verse (e.g. text before a colon, or in quotation marks) must appear in the current verse text (Major). Aquilla's *Footnote quote* check overlaps; report once.
2. **Note reference:** a note's own reference (e.g. `3:16`) must equal the verse it belongs to (Major).
3. **Scripture references** inside notes (`Book C:V`):
   * The book name or abbreviation must be in the book-names list (Major).
   * The chapter and verse must exist (Major).
   * Separators and range characters must follow the verified convention (Minor).
4. **Note style:** notes start and end following the verified style (Minor).

#### Headings

5. **Missing heading:** a heading in the source text at this place with no target heading (Major; Query if the team deliberately uses fewer headings).
6. **Untranslated heading:** a heading in the source language (Major).
7. **Heading style:** case and final punctuation follow `style/conventions` (Minor).

#### Book names

8. Each book has a full name, a short name and an abbreviation, consistent with the list (Major).
9. **Duplicate abbreviations** across books (Critical: they break navigation).

#### Front matter (book level)

10. List what front matter exists (title page, copyright, usage statement) and what's missing. Rights & Permissions approves the wording; don't change it.

### Output

Use the findings table from `qa-run-book`, plus a book-names table:

| Book | Full name | Short name | Abbreviation | Issue |
