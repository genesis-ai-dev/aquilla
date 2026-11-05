---
name: qa-meaning-fidelity
description: Compare target verses with the project's source text through a literal back translation, and flag possible omissions, additions, meaning shifts and doctrinal risks for the mentor. Targeted and expensive; run on doctrinal passages and edited cells first.
pass: 4 Meaning
verifier: Mentor (decides); post-editor (fixes); consultant only for doctrinal Queries the mentor routes
---

# qa-meaning-fidelity — Omissions, additions, meaning shifts

### Why

Accuracy errors are the most serious human errors: a clause dropped from a long Pauline sentence, an added explanation, a lost negation, a swapped subject. Approved books have already been checked twice, so this pass is **targeted triage for the mentor**, not a full re-check.

### Known limits (state them in every report)

* AI understanding of low-resource languages is weak. Research on African languages found that the best automatic judges agree with humans only moderately (correlation about 0.6).
* So every finding here is Confidence Medium or Low, unless the problem is visible mechanically (e.g. a name or number is missing).
* Phrase findings as questions for the mentor, with evidence.

### Scope priority (cost control)

1. **Doctrinally significant passages** in the scope: JHN 1:1-18; PHP 2:6-11; COL 1:15-20; JHN 14-16; ACT 2; GAL 5; ROM 3-5; GAL 2; 1CO 15; EPH 2:8-9; JAS 2; ISA 7, 9, 53; PSA 22; plus the Gospel resurrection accounts.
2. **Cells edited since approval** (Aquilla edit history), and all cells of remaining books.
3. **Long or complex sentences:** source verses over 40 words.
4. Unedited cells of approved books: skip unless asked.

### Inputs

* The **project's source text**, named in the Project brief.
* Aquilla's literal AI back translation, using hand-corrected readings where they exist.
* The meaning-carrying markers from a verified `style/grammar-profile` (negation, plural, tense), if available.

### Procedure

1. For each verse, get the literal back translation (BT). If the reading is stale, regenerate it.
2. Compare the BT with the source text, proposition by proposition: who did what to whom, when, why, with what result. Check for:
   * **Omission:** a proposition, participant, negation, quantifier (all/some/none), time or place phrase, or quotation in the source that is missing from the BT.
   * **Addition:** content in the BT that isn't in the source and isn't justified as implicit information.
   * **Shift:** a different subject or object, a changed agent, a changed tense or aspect that alters meaning, a figure of speech made literal or lost, or a pronoun pointing to the wrong person.
3. **Marker check.** If a grammar profile exists, use sandbox code to check that a source negation has a target negation marker, and that a source plural has a plural marker (High confidence when the marker is absent).
4. **Statistical cross-check.** If Aquilla shows *Statistical gloss differs*, note it as evidence for or against the finding.
5. **Doctrinal guardrails:** Christology, Trinity, salvation language, covenant, atonement terms; *Son of God*, *Holy Spirit*, *kingdom of God*; faith vs works. Any concern is a Query to the mentor, marked `doctrinal`, so the mentor can involve a consultant.
6. **Naturalness signals** (Query to the mentor): very long sentences, source-language word order, or unusually many words borrowed from the source language.

### Output

Use the findings table from `qa-run-book`, plus a block for each Major finding:

```
ROM 3:22  [Major | Medium]  Possible omission
Source: "<source text phrase>"
BT:     "<back translation phrase>"
Issue:  "<what seems missing or changed>"
Ask:    "<question for the mentor>"
```

### Do not

* Rewrite the verse. Propose a direction only.
* Mark anything Critical unless the mentor has confirmed it in this session.
* Treat an awkward-sounding BT as a problem by itself; the BT is literal on purpose.
