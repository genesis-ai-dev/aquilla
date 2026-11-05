---
name: qa-capitalization-numbers
description: Check capitalization, numbers and repeated words in the scope against the verified conventions from the approved books and against the source text. Equivalent to the Paratext Capitalization, Numbers and Repeated Words checks.
pass: 1 Mechanical
verifier: Proof-reader (the mentor decides any new convention)
---

# qa-capitalization-numbers — Capitalization, numbers, repeated words

### Why

These are the commonest typing slips. Numbers matter most, because a changed age, measure or count changes the meaning. Aquilla's built-ins catch numerals missing from the target; this skill adds the team's conventions.

### Baseline

Memory note `style/conventions`, verified through `qa-bootstrap-inventories`: capitalization of recurring words, divine pronouns, titles, and the number style by size band.

If the script has no upper/lower case (e.g. Arabic, Ethiopic, Thai, Burmese), skip capitalization and say so.

### Procedure (sandbox code)

#### Capitalization

1. Sentence starts: the first letter after a sentence-end mark, and at the start of each cell where the source verse starts a sentence (Minor; overlaps with Aquilla's *Capitalization*, so report once).
2. Recurring words: any word in `style/conventions` written in the non-approved case (Major, with an autofix suggestion).
3. New inconsistencies: words appearing both capitalized and lowercase in mid-sentence that aren't in the baseline. Give counts per form (Query to the mentor).
4. Names: termbase names must keep their recorded case (Major).

#### Numbers

1. Pair the numbers in each source verse with the target verse, as numerals or number words, following the verified number style. Match digits across scripts (40 = ٤٠ = ၄၀).
2. Report:
   * A missing or changed number (Major).
   * A number written against the verified style for its size band (Minor).
   * Mixed digit scripts in one number (Major).
3. Measures and money: report inconsistent handling of the same unit across the scope (Minor).

#### Repeated words

1. List each immediately repeated word, including across a punctuation mark.
2. If the source text repeats it at that verse (e.g. *Saul, Saul*; *Truly, truly*; *Holy, holy, holy*), mark it intentional and drop it. Otherwise report it as Minor.

### Output

Use the findings table from `qa-run-book`, grouped by rule.
