---
name: qa-bootstrap-inventories
description: Mine the approved books (already checked twice) for the project's characters, punctuation, conventions, wordlist, key terms and names, and produce verification lists the team only approves or rejects. Run once before QA of the remaining books.
pass: 0 Bootstrap
verifier: Proof-reader (characters, punctuation, wordlist); Mentor (conventions, key terms, names)
---

# qa-bootstrap-inventories — Build the baseline from approved books

### Why

The approved books are the best evidence of how this team writes its language. Instead of asking people to write lists of approved characters, spellings and renderings, the agent builds the lists from that evidence, marks outliers, and pre-fills a suggested decision. People only verify. The verified lists then become the standard that every other skill checks against.

### Inputs

* The **approved books** and the **source text**, as named in the Project brief.
* Any Style Guide in the Knowledge base. Optional; the lists can be built without one.
* The verified grammar profile from `qa-grammar-profile`, if one exists, to group inflected forms in the wordlist.

### Rules for every list

* Built with **sandbox code**, from the approved books only. Show the code output summary.
* Each row has: item, count, share of all uses, 3 sample references, **Outlier?** (with the reason), **Suggested** (Approve / Reject / Decide), and an empty **Decision** column for the team.
* **Suggested = Approve** when the item is the dominant form (95% or more of its group) and not an outlier. **Reject** when it is clearly an error (e.g. a control character). **Decide** for everything else.
* Sort with outliers and *Decide* rows first, then by count.
* Deliver each list as a CSV file **and** as a short summary in chat: totals, number of outliers, and the top 10 items to decide.

### Lists to build

#### 1. Characters (`characters.csv`, verified by the proof-reader)

Every character, after Unicode NFC normalization: character, code point (U+XXXX), Unicode name, script, count, samples.
Outliers:

* Fewer than 3 uses.
* A script other than the language's main script; also flag mixed-script words.
* Invisible or control characters: U+200B, U+200C/U+200D (unless the script needs them), U+FEFF, U+00AD, control codes.
* Look-alikes used side by side (e.g. U+0027 `'` vs U+2019 `’`; Latin `o` vs Cyrillic `о`; hyphen U+002D vs en dash U+2013).
* Characters that change under NFC normalization.

#### 2. Punctuation and spacing (`punctuation.csv`, proof-reader)

For each punctuation mark: code point, count, and the spacing pattern before and after it (none, space, no-break space), with the share of each pattern.
Outliers: a minority spacing pattern (under 5%), and two code points used for the same function.
Also infer and list:

* The **quotation system:** opening and closing marks per nesting level, and what happens at a paragraph break inside a quote.
* **Sentence-end marks**, and whether the language uses them at all.
* **Abbreviations:** tokens followed by `.` and then a lowercase letter.

#### 3. Conventions (`conventions.csv`, mentor)

For each convention, the majority form and the minority forms, with counts:

* Capitalization of recurring words in mid-sentence (e.g. Tabernacle/tabernacle, Law/law), divine pronouns, and LORD-type titles.
* Numbers: digits vs words, by size band (1–10, 11–100, >100); the digit script used.
* Heading style (sentence vs title case; ends with punctuation or not), if headings exist.
* Footnote style (how notes start and end), if notes exist.

#### 4. Wordlist (`wordlist.csv`, proof-reader)

Every word with its count and samples. Group by lemma when a verified grammar profile gives the affixes.
Outliers, with the matched word named in the reason:

* **Variant pair:** edit distance 1 (or 2 for words of 8+ letters) from a word at least 10 times more frequent.
* **Joined/split:** `XY` and `X Y` (or `X-Y`) both occur.
* **Single-use** word close to a frequent word.

Suggested = Approve for words with 3 or more uses and no outlier flag. The proof-reader reviews outliers first, then bulk-approves the rest by frequency band.

#### 5. Key terms (`keyterms.csv`, mentor)

For each concept in the **Biblica Key terms list** (Knowledge base; the source-language version when the source text isn't English), plus any existing termbase concept. Use the priority terms in `qa-key-terms-names` only if the list isn't loaded:

1. Find the verses in the approved books where the source text contains the term.
2. Rank target words and phrases by how strongly they co-occur with those verses compared with all other verses (Dice coefficient or similar). Use Aquilla's statistical gloss or alignment where available.
3. List the top candidate rendering(s), with coverage: the share of the term's verses that contain the rendering.

Suggested = Approve when one rendering covers 90% or more of the verses. Otherwise Decide, listing each rendering with its verses. The columns follow Aquilla's CSV import order: `source term, rendering, status, notes`. Keep the list's ID in the notes, so a concept matches across projects.

#### 6. Proper names (`names.csv`, mentor)

Find target words that align with source-text names (capitalized words, or names in the source text's name list). Cluster spelling variants of each name (edit distance ≤ 2) and give counts per spelling. Suggested = Approve for the dominant spelling; Decide when there are two or more spellings.

### After the team verifies

When the team returns the CSVs with the Decision column filled, or confirms decisions in chat:

1. Propose memory notes: `style/characters`, `style/punctuation`, `style/quotations`, `style/conventions`, `glossary/wordlist-approved`, `glossary/wordlist-incorrect`, `glossary/names`.
2. Produce `termbase-import.csv`: approved renderings marked *required*, rejected ones *forbidden*.
3. Draft custom rules for the Project lead, e.g. a forbidden character (regex with an autofix to the approved character), a forbidden spacing pattern, or a forbidden variant spelling (autofix to the approved form).
4. Propose the Language profile punctuation set.
5. Report the baseline date and the counts approved / rejected per list.

### Do not

* Approve anything yourself. *Suggested* is a pre-fill, not a decision.
* Build the baseline from books that are not on the approved list.
* Treat the majority as correct when it is under 95%. That is a Decide row.
