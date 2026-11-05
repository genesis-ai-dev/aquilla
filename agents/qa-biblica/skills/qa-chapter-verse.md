---
name: qa-chapter-verse
description: Check that every chapter and verse is present once, in order, and in its own cell, by comparing Aquilla cell references with the source text. Works on plain text; no USFM needed.
pass: 1 Mechanical
verifier: Post-editor
---

# qa-chapter-verse — Chapter and verse completeness (plain text)

### Why

A missing or duplicated verse is the most damaging mechanical error. Common causes: a skipped verse in Scripture Forge, copy-paste of the previous verse, two verses typed into one cell, or a verse bridge entered differently from the source.

### How the structure is read

* Use Aquilla's cell references (`BOOK C:V`) for both the source text and the target.
* Ignore any markup characters left in the text; `qa-text-integrity` reports those.

### Procedure (sandbox code)

1. List every target cell reference with its text, and every source cell reference.
2. Compare the two, chapter by chapter, and report:
   * **Missing verse:** a source cell has text, but the target cell is empty or missing, and the verse isn't part of a target bridge.
   * **Extra verse:** a target cell with text whose reference isn't in the source.
   * **Duplicate:** the same reference appears twice.
   * **Bridge mismatch:** the target joins verses the source keeps separate, or splits a source bridge. This is a Query; it may be deliberate.
   * **Merged verses:** a target cell is much longer than its source verse (over 1.8× the book's median target/source length ratio), while the next cell is empty or very short. Show both cells.
   * **Split verse:** a target cell is very short while its neighbour is very long, in the opposite pattern.
   * **Duplicated text:** a cell identical to the cell before or after it, or to any cell in the same chapter.
   * **Verse number typed in the text:** a cell that starts with its own or another verse's number (e.g. `16 For God…`).
3. **Textual-variant verses** (e.g. MAT 17:21, MAT 18:11, MAT 23:14, MRK 7:16, MRK 9:44, MRK 9:46, MRK 11:26, MRK 15:28, LUK 17:36, LUK 23:17, JHN 5:4, ACT 8:37, ACT 15:34, ACT 24:7, ACT 28:29, ROM 16:24, and the passages MRK 16:9–20 and JHN 7:53–8:11). Follow the **project's source text**: if the source includes the verse, the target should too; if the source omits it or marks it as a note, the target should match. Report a mismatch as Major.
4. Check that the number of chapters matches the source for each book.

### Output

Use the findings table from `qa-run-book`, with the code output in a collapsed block.

| Finding | Severity |
| -- | -- |
| Missing, extra, duplicate, merged or split verse | Critical |
| Duplicated text | Major |
| Verse number typed in the text | Major |
| Textual-variant mismatch with the source | Major |
| Bridge mismatch | Query |

### Do not

* Insert verses or text. Propose the fix, and quote the source verse for the post-editor.
