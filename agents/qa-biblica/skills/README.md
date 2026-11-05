# Aquilla QA Skills – Biblica

A library of 13 Markdown skill files for the Aquilla AI agent. They run the final QA of a translation drafted in Scripture Forge, after it is imported into Aquilla, before digital publication. Each file is a playbook: the agent reads it and follows it when you name the skill in the composer.

**Design principles**

* **The text is plain text.** No check relies on USFM markup; the text does not go back to Paratext.
* **The source text is set per project** in the Project brief. No default model text such as NIV is assumed.
* **People verify; they don't create.** The approved books (checked twice) become the baseline. The AI builds the lists and the team ticks Approve or Reject.
* **Roles:** post-editors fix, proof-readers verify lists and mechanical findings, and mentors decide on meaning, key terms and the publish gate. A consultant is asked only about flagged doctrinal passages.

### Install (once per project)

1. **Import.** Import the project (synced Scripture Forge → Paratext) into Aquilla as a Paratext .zip, choosing *Translation in progress*. Import the project's source text as the source.
2. **Project brief.** Paste the *QA operating rules* block below, and fill in the source text and the list of approved books. Only a Project lead can do this.
3. **Knowledge base.** Upload the 13 `qa-*.md` files, plus:
   * the **Biblica Key terms list**, in the source text's language (for an NIV-source project, the English list);
   * `parallel-passages.md`, converted from `ParallelPassages.xml` (the Knowledge base doesn't take XML; see `qa-parallel-passages`);
   * any Style Guide, Translation Brief or grammar paper.
     3a. **Termbase.** Import the Key terms list as draft concepts (CSV: `source term, rendering, status, notes`). The bootstrap fills in the renderings for verification; see `qa-key-terms-names`.
4. **Bootstrap.** Run `qa-bootstrap-inventories` on the approved books. The team verifies the lists it produces. The Project lead then imports the termbase CSV and approves the proposed rules and memory notes.
5. **Grammar paper (optional).** Run `qa-grammar-profile`. The mentor verifies the rules it proposes.
6. **Built-in checks.** In Living Memory → Translation quality, switch on all built-in checks except *USFM markers* and *Length mismatch*.
7. **Agent mode.** Set it to *QA only*, with scope *Checks only*.

### How to run

| You type in the composer | What happens |
| -- | -- |
| `Run qa-bootstrap-inventories on approved books` | Builds the verification lists (once) |
| `Run qa-run-book on [MRK]` | Runs every pass on a remaining book and writes one report |
| `Run qa-run-book on approved books, edited cells only` | Re-checks cells changed since approval |
| `Run qa-meaning-fidelity on [ROM 3]` | Runs the expensive AI pass on one chapter |

If the agent says it can't see a skill, attach the `.md` file with **Attach file** and repeat the request.

### QA operating rules (paste into the Project brief)

```
QA OPERATING RULES (Biblica)
- Source text for this project: <name of source text>. Approved books (checked twice): <list>.
- The text is plain text. Ignore any markup; never require USFM.
- When asked to "run qa-<name>", open that file in the Knowledge base and follow it exactly.
- Never edit cells directly. Propose every fix as a reviewable change; one change per finding.
- Counts, inventories, verse lists, numbers and pattern checks must be done with sandbox code, not by reading. Show the code output.
- Every finding carries: Ref (BOOK C:V), Check, Severity (Critical/Major/Minor/Query), Confidence (High/Medium/Low), Evidence, Proposed fix, Verifier (Post-editor/Proof-reader/Mentor).
- The verified baseline (memory notes under style/ and glossary/, plus the termbase) is the standard. Report only deviations from it.
- This is a low-resource language. Do not judge spelling, grammar or naturalness from your own knowledge. Use only the verified baseline, the verified grammar profile and validated examples. When unsure, raise a Query for the mentor.
- The source text is a meaning reference, not a form target. Never "fix" target syntax to match the source language.
- Never auto-fix spelling variants, key terms, names or meaning. Propose; a person decides.
- Group identical issues into one finding with all references.
- End every run with the summary table defined in qa-run-book.
```

### Skills

| File | Pass | Checks | Verified by |
| -- | -- | -- | -- |
| `qa-run-book.md` | All | Orchestrator, severity rules, report format | Mentor |
| `qa-bootstrap-inventories.md` | 0 | Baseline lists mined from approved books | Proof-reader, Mentor |
| `qa-grammar-profile.md` | 0 (optional) | Grammar paper → tested rules | Mentor |
| `qa-chapter-verse.md` | 1 | Missing, duplicate, merged and out-of-order verses | Post-editor |
| `qa-text-integrity.md` | 1 | Stray code, leftover source text, duplicated text, empty cells | Post-editor |
| `qa-characters-punctuation.md` | 1 | Characters, punctuation, unmatched pairs, quotations | Proof-reader |
| `qa-capitalization-numbers.md` | 1 | Capitalization, numbers, repeated words | Proof-reader |
| `qa-spelling-wordlist.md` | 2 | New words, variants, joined/split words | Proof-reader |
| `qa-key-terms-names.md` | 3 | Key terms and proper names | Mentor |
| `qa-parallel-passages.md` | 3 | Parallel passage consistency | Mentor |
| `qa-meaning-fidelity.md` | 4 | Omissions, additions, meaning shifts, doctrine | Mentor (consultant for doctrine) |
| `qa-notes-headings-names.md` | 5 | Footnotes, references, headings, book names | Proof-reader |
| `qa-publish-readiness.md` | 5 | Final gate checklist | Mentor |
