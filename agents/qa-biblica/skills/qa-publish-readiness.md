---
name: qa-publish-readiness
description: Final publish-gate check for a book or the whole project before digital publication (Scripture App, DBL). Confirms every QA pass is closed and produces a sign-off summary for the mentor.
pass: 5 Publish
verifier: Mentor signs off
---

# qa-publish-readiness — Publish gate

### Why

After this gate, the text goes to digital publication. This skill checks that nothing open is carried over, and that the verified baseline was applied to every book.

### Procedure

1. **Latest report.** Find the most recent `qa-run-book` report for each book in scope. If a report is older than the book's last edit, or missing, run `qa-run-book` first.
2. **Gate checks.** Mark each item PASS, FAIL or UNKNOWN, with evidence.

| \# | Gate item | How to check | Owner |
| -- | -- | -- | -- |
| 1 | Baseline verified (characters, punctuation, conventions, wordlist, key terms, names, book names) | Memory notes + termbase; bootstrap date | Proof-reader, Mentor |
| 2 | 0 open Critical findings | Latest reports + Violations inbox (red, not waived) | Post-editor |
| 3 | Every Major resolved, or waived with a reason and the mentor's name | Reports + waiver notes | Mentor |
| 4 | No open comments | Aquilla comments | Post-editor |
| 5 | Required validation count met on every cell | Validation status | Proof-reader, Mentor |
| 6 | No unapproved new words with 3 or more uses | qa-spelling-wordlist output | Proof-reader |
| 7 | Every verse present once, with no merged verses and no stray code | Pass 1 results | Post-editor |
| 8 | Key terms and names consistent; parallel passages reviewed | Pass 3 results | Mentor |
| 9 | Meaning Queries closed; doctrinal Queries closed by the mentor or consultant | Pass 4 results | Mentor |
| 10 | Notes, headings and book names clean; front matter present | qa-notes-headings-names | Proof-reader |
| 11 | Cells edited after approval re-checked | Edited-cells run of qa-run-book | Mentor |

3. **Export sanity.** Export the scope in the format the digital publishing step needs. Check that the export has no errors, and that its verse count equals the Pass 1 count.

### Output

```
# Publish readiness — <scope> — <date>
Result: READY / NOT READY
| # | Gate item | Result | Evidence | Owner |
Blocking items: <list with owners>
Sign-off: Mentor
```

### Do not

* Mark READY if any item is UNKNOWN. Ask the owner instead.
* Sign off on behalf of a person, or change validation status.
