---
name: qa-spelling-wordlist
description: Check spelling in the scope against the approved wordlist built from the approved books. Report only new words, known-incorrect words, variants, and joined/split forms, without relying on a dictionary. Replaces the Paratext Wordlist spell-check for low-resource languages.
pass: 2 Spelling
verifier: Proof-reader (the mentor decides orthography questions)
---

# qa-spelling-wordlist — Spelling against the approved baseline

### Why

There is no spell-checker for most of our languages, and some orthographies are still settling. The approved books act as the dictionary. Only words that aren't already approved need a person's attention.

### Baseline (required)

* `glossary/wordlist-approved` and `glossary/wordlist-incorrect`, from `qa-bootstrap-inventories`.
* Optional: the affix and clitic list from a verified `style/grammar-profile`, used to recognize inflected forms of approved words.

### Procedure (sandbox code)

1. **Tokenize** the scope: NFC-normalize, strip punctuation, and keep internal hyphens and apostrophes if the baseline treats them as word characters.
2. **Classify each word:**
   * **Approved:** in the approved list, or an approved stem plus verified affixes. Silent.
   * **Incorrect:** in the incorrect list. Major, with the approved spelling as the fix (autofix allowed if a rule exists).
   * **Variant:** not approved, but within edit distance 1 (or 2 for words of 8+ letters) of an approved word, or differing only by a doubled letter, a diacritic, a hyphen or space, or case. Major, with the likely intended word.
   * **Joined/split:** `XY` where `X Y` is approved, or the reverse. Major.
   * **New:** none of the above. Query, for the proof-reader to approve or reject.
3. **Sort the new words** by count, so frequent ones get decided first. Words used once are the most likely typos.
4. **After the proof-reader decides,** propose additions to `glossary/wordlist-approved` and `glossary/wordlist-incorrect`. For repeated errors, propose a custom rule with an autofix.

### Output

* Findings table (from `qa-run-book`): Incorrect, Variant and Joined/split rows.
* The new-word list: word, count, references, nearest approved word, and an empty *Decision* column. Offer it as a CSV.

### Do not

* Judge spelling from your own knowledge of the language.
* Bulk-replace variants without the proof-reader's decision.
