---
name: qa-parallel-passages
description: Compare parallel passages (Synoptic Gospels, Kings/Chronicles, OT quotations in the NT, repeated formulas) and flag differences in the target that the source doesn't have. Equivalent to the Paratext Parallel Passages tool.
pass: 3 Consistency
verifier: Mentor
---

# qa-parallel-passages — Parallel passage consistency

### Why

Parallel accounts are often drafted months apart by different post-editors. Readers who compare them see differences the original doesn't have. The goal: **where the source wording is the same, the target should be the same; where the source differs, the target should differ in the same way.**

### Inputs

* **Biblica parallel-passages list** (`ParallelPassages.xml`, the Paratext parallel-passages database format). The Aquilla Knowledge base accepts only Markdown, TXT, DOCX and PDF, so upload the converted `parallel-passages.md` (below). For a one-off run, attach the XML with **Attach file** instead.
* The **project's source text** for every passage (Project brief).
* Aquilla's literal back translation, and the verified termbase (key terms and names).

### Converting the list (once)

Parse the XML with sandbox code. Write one table row per parallel set: `Set ID | Type (e.g. synoptic, OT quote, duplicate account) | References (‖-separated) | Notes`. Keep the XML's own IDs and types as they are; don't invent groupings. Save the table as `parallel-passages.md` and report the count of sets and references, so the mentor can confirm nothing was lost.

### Run order (cost control)

1. Sets where at least one passage is in a remaining book, or in cells edited since approval.
2. Sets entirely inside approved books: skip, unless asked. They were checked twice.
3. Within a run, the sets whose passages the source text words identically come first, because there any target difference is a likely error.

### Core set (fallback only, if the Biblica list isn't loaded)

* Sermon/teaching: MAT 6:9-13 ‖ LUK 11:2-4 (Lord's Prayer); MAT 5:3-12 ‖ LUK 6:20-23
* Miracles: MAT 14:13-21 ‖ MRK 6:30-44 ‖ LUK 9:10-17 ‖ JHN 6:1-14 (feeding of the 5,000); MAT 8:23-27 ‖ MRK 4:35-41 ‖ LUK 8:22-25
* Passion: MAT 26:26-29 ‖ MRK 14:22-25 ‖ LUK 22:17-20 ‖ 1CO 11:23-25 (Lord's Supper); MAT 27:45-56 ‖ MRK 15:33-41 ‖ LUK 23:44-49
* Resurrection: MAT 28:1-10 ‖ MRK 16:1-8 ‖ LUK 24:1-12 ‖ JHN 20:1-10
* Law: EXO 20:1-17 ‖ DEU 5:6-21 (Ten Commandments)
* History: 2SA 22 ‖ PSA 18; 2KI 18:13-20:19 ‖ ISA 36-39; 1KI and 2KI ‖ 1CH and 2CH parallels from the list
* OT in NT: ISA 53:7-8 ‖ ACT 8:32-33; PSA 110:1 ‖ MAT 22:44; GEN 15:6 ‖ ROM 4:3; HAB 2:4 ‖ ROM 1:17
* Repeated formulas: the GEN 1 creation-day formula ("And there was evening, and there was morning…"); the AMO 1-2 "For three sins… even for four" formula

### Procedure

1. For each set, align the passages verse by verse. In the source text, mark the spans that are **identical**, **near-identical** (same words, small differences), or **different**.
2. Compare the target spans:
   * Source identical but target different → **Major** (show both target texts side by side with the difference highlighted).
   * Source different but target identical → **Query** (a post-editor may have harmonized them).
   * Near-identical → check that key terms and names match (link to qa-key-terms-names).
3. Use sandbox code to compute the word-level diff of the target spans. Then explain each difference in one line, using Aquilla's literal back translation for both spans.
4. For OT quotations in the NT, also check that the NT wording follows the Brief: either quote the team's OT rendering, or translate the NT Greek, and footnote if required.

### Output

Use the findings table from `qa-run-book`, plus one side-by-side block per flagged set:

```
MAT 14:19 | MRK 6:41
target A ... | target B ...
BT A ...     | BT B ...
Difference: <one line>  Source: identical
```

### Do not

* Harmonize passages the source keeps different. Gospel writers differ on purpose.
