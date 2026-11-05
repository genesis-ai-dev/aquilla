---
name: qa-key-terms-names
description: Check that Biblical key terms and proper names are rendered consistently and as approved across the scope, and surface unjustified variation. Equivalent to the Paratext Biblical Terms tool check.
pass: 3 Consistency
verifier: Mentor (decides renderings); consultant only for doctrinal Queries the mentor routes
---

# qa-key-terms-names — Key terms and names

### Why

If *covenant* is translated three ways, readers may think there are three concepts. Names drift too (Abraham/Ibrahim/Abram) when several post-editors work. Biblica's rule: **consistency is the goal, not rigidity.** Some contexts justify a variant, and a person decides which.

### Inputs

* **Biblica Key terms list** (Knowledge base). Each entry is a concept with its source-language term(s).
  * **When the source text is English (e.g. NIV):** use the English list directly as the source terms.
  * **When the source text is another language:** use the source-language version of the list, aligned to the English list by row or ID, so each concept keeps one ID across projects. Without one, report "source-language key terms list missing" and fall back to the English list via the Hebrew/Greek alignment, if loaded (Confidence Low).
* **Aquilla termbase**, seeded from the list (see *Termbase set-up*). It holds active concepts with *required*, *alternate* and *forbidden* renderings, verified through `keyterms.csv` and `names.csv` from `qa-bootstrap-inventories`.
* The **project's source text** (Project brief) to find where each term occurs.

### Termbase set-up (once, uses Aquilla's native terminology checks)

1. Convert the Key terms list to Aquilla's CSV import format: `source term, rendering, status, notes`. Leave the rendering and status empty, and put the list's ID, category and gloss in the notes. In Aquilla, set the imported concepts to *draft*, so they aren't enforced before they are verified. (`status` in the CSV is the rendering status, not the concept's draft/active state.)
2. `qa-bootstrap-inventories` fills in the candidate renderings mined from the approved books. The mentor verifies them.
3. Re-import the CSV with the verified renderings: required = the approved rendering, alternate = an accepted variant, forbidden = a rejected one. Set the concept to *active*, so Aquilla enforces it while people type.
4. Use the termbase `*` wildcard for inflected forms. Take the affixes and clitics from the verified `style/grammar-profile`, or from the frequent affixes found by `qa-bootstrap-inventories`, not from your own knowledge of the language. Set up Aquilla's affix matching (prefixes and suffixes, ignoring vowel marks and accents where the orthography needs it), and exclude false matches in the concept's form list for the mentor to confirm.
5. From then on, Aquilla's native checks do the routine work: amber for a missing required rendering, red for a forbidden one, and an entry in the Violations inbox. This skill adds what Aquilla doesn't do: split usage across the book, collisions, names, and doctrinal flags.

### Procedure

1. **Occurrences:** for each concept in the Key terms list (or the priority terms, as a fallback) and each active termbase concept, list the verses where the source term occurs (from the project's source text, or the original-language alignment if loaded). Use the termbase's `*` wildcard and affix settings to match inflected forms.
2. **Read Aquilla's results first:** take the terminology violations (missing required, forbidden) for the scope from the Violations inbox; don't re-report them.
3. **Renderings found:** for each occurrence, find which rendering (required, alternate, or none) appears in the target verse. Use sandbox code for matching and report counts.
4. **Report:**
   * **Missing rendering:** a source occurrence where no known rendering appears in the target (Query; the post-editor may have used a pronoun or restructured).
   * **Forbidden rendering present** (Major; Aquilla also flags it).
   * **Split usage:** two or more renderings used for the same sense. Give counts and references per rendering (Major). Note where context might justify the variation, e.g. *kingdom of God* vs *kingdom of heaven* are both valid, but must not be merged.
   * **Collision:** one target word used for two distinct key terms (e.g. the same word for *spirit* and *ghost*, or for *Lord* and *LORD* where the Brief distinguishes them) (Major).
5. **Proper names:** extract the target words aligned with source-text names, cluster spelling variants (edit distance ≤ 2, same first letter), and match them to the termbase. Report each name with more than one spelling (Major), with counts.
6. **Doctrinal guardrails (flag, don't decide), from the Standard Plan:**
   * *Son of God* must not read as physical offspring.
   * *Holy Spirit* must not read as "ghost" in a misleading sense.
   * Justification and faith terms must not become "obedience" or "works".
   * *Kingdom of God* must not read as an earthly government.
   * Titles for God and Christ must not diminish deity.
   * No rendering may imply another deity.

   When a back translation of the rendering suggests one of these, raise a Query for the mentor, with evidence. The mentor decides whether to involve a consultant.
7. **Baseline first:** a rendering that matches the termbase's *required* rendering is silent. Report only deviations, and occurrences in cells edited since approval.
8. **Proposals:** offer termbase updates (new alternate, status change) as proposals for the Project lead, once the mentor agrees. Never change term status yourself.

### Output

Use the findings table from `qa-run-book`, plus a term table:

| List ID | Concept | Required rendering | Renderings found (count) | Missing occurrences | Aquilla violations | Status |
