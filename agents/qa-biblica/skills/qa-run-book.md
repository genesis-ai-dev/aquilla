---
name: qa-run-book
description: Run the full QA workflow on a book, range, or the edited cells of approved books, and produce one QA report. Use when asked to "run QA" or "run qa-run-book".
pass: all
verifier: Mentor
---

# qa-run-book — QA orchestrator

### Goal

Run every QA pass in order on the given scope, check it against the verified baseline, and report only deviations. State whether the scope is ready for the publish gate.

### Before you start

* Read the Project brief for the **source text** and the list of **approved books**.
* Check that the baseline exists: memory notes `style/characters`, `style/punctuation`, `style/conventions`, `glossary/wordlist-approved`, and active termbase concepts. If any is missing, stop and suggest running `qa-bootstrap-inventories` first.
* The text is plain text. Never check or require USFM.

### Scope modes

| Mode | Example request | Runs |
| -- | -- | -- |
| Remaining book | `Run qa-run-book on [MRK]` | Passes 1–5 on every cell |
| Approved books, edited cells | `Run qa-run-book on approved books, edited cells only` | Passes 1–3 on cells edited since approval, plus Pass 4 on doctrinal passages |
| Single chapter | `Run qa-run-book on [ROM 3]` | Passes 1–4 |

### Order

1. **Mechanical:** `qa-chapter-verse`, `qa-text-integrity`, `qa-characters-punctuation`, `qa-capitalization-numbers`
2. **Spelling:** `qa-spelling-wordlist`
3. **Consistency:** `qa-key-terms-names`, `qa-parallel-passages`
4. **Meaning:** `qa-meaning-fidelity` (targeted; see its scope priority)
5. **Publish:** `qa-notes-headings-names`, then `qa-publish-readiness` (book level only)

### Procedure

1. Confirm the scope and mode in one line.
2. Read Aquilla's Violations inbox for the scope, so built-in findings aren't reported twice. Cite built-in findings by check name only.
3. Run each skill in order, following each skill file exactly.
4. If Pass 1 has Critical findings, still run Pass 2, but note that Passes 3–4 may shift after fixes.
5. If the run hits its step or token cap, stop at the end of a skill, report progress, and say which skill to continue with.
6. Merge and de-duplicate findings. Group the same issue across verses into one row with all references.
7. Write the report as a comment on the first cell of the scope, and offer it as a file.

### Severity (shared by all skills)

| Severity | Use for | Aquilla |
| -- | -- | -- |
| Critical | Missing, merged or duplicated verse; stray code in the text; corrupted characters; wrong book name; confirmed theological error | Red, with `[CRITICAL]` in the comment |
| Major | Probable meaning error, omission or addition, key-term or name inconsistency, number mismatch, unpaired quote, a word not in the approved wordlist that is close to an approved one | Red |
| Minor | Spacing, capitalization, style drift, likely-intentional repetition | Amber |
| Query | Anything uncertain, or needing a mother-tongue judgment | Comment only |

**Confidence:** High = verified by code or an exact match with the baseline; Medium = a pattern match that needs a glance; Low = AI judgment in this language. Low confidence is always a Query.

**Verifier:** Post-editor (structure, integrity), Proof-reader (characters, punctuation, spelling, notes), Mentor (terms, names, parallels, meaning, gate). Consultant: doctrinal Queries only, routed by the mentor.

### Report format

```
# QA report — <scope> — <date>
Source text: <name>   Baseline: verified <date>

## Summary
| Pass | Critical | Major | Minor | Query |
|------|---------:|------:|------:|------:|
Gate status: READY / NOT READY (<n> Critical open, <n> Major open)

## Findings (grouped; sorted Critical → Query, then by number of verses)
| # | Refs | Skill | Severity | Confidence | Found | Baseline / evidence | Proposed fix | Verifier |

## Not checked
<anything skipped, and why>
```

### Do not

* Give a numeric quality score.
* Apply fixes, approve terms, or approve words.
* Report anything that matches the verified baseline.
