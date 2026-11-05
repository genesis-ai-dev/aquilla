---
name: qa-grammar-profile
description: Turn a grammatical analysis paper on the target language into a tested grammar profile and QA rules, keeping only rules the approved books confirm. Without a paper, draft a descriptive profile from the approved books. Optional; run once in Pass 0.
pass: 0 Bootstrap (optional)
verifier: Mentor
---

# qa-grammar-profile — Grammar paper → verified QA rules

### Why

The AI knows little about most low-resource languages, but a published grammar does. A paper can give the spelling and grammar checks real rules: which affixes attach to words, how negation and plural are marked, which letters the alphabet allows. Papers can also describe another dialect, an older orthography, or a phonetic (IPA) notation. So **every rule is tested against the approved books, and the team's approved practice wins.**

### Inputs

* The grammar paper in the Knowledge base (PDF or DOCX, up to 25 MB).
* The approved books (Project brief).
* The verified wordlist and character list from `qa-bootstrap-inventories`, if they exist.

### Procedure

1. **Notation check.** Compare the paper's example words with the approved text. If the paper uses IPA or another orthography, build a mapping table (paper symbol → project letter) and ask the mentor to confirm it before going on.
2. **Extract rules** into these categories. For each rule, record: ID, statement, page, the paper's example, and the project spelling of the example.
   * Alphabet: letters, digraphs, diacritics, tone marks
   * Word boundaries: prefixes, suffixes, clitics (joined or separate), compounds, reduplication (hyphenated or not)
   * Noun phrase: plural, noun class, case, possessive markers
   * Verb: tense/aspect/mood markers, negation, subject/object agreement
   * Word order: basic clause order, position of modifiers
   * Function words: pronouns, conjunctions, prepositions or postpositions
   * Writing conventions mentioned: punctuation, capitalization, numbers
3. **Classify how each rule can be tested:**
   * **Pattern:** testable with regex or a word list (e.g. "the clitic =ni is written joined").
   * **Lexical:** a closed list of forms (pronouns, negators, plural markers).
   * **Judgment:** needs understanding (word order, agreement). Never enforced automatically.
4. **Test pattern and lexical rules on the approved books** with sandbox code. Count how often the text follows the rule and how often it breaks it.
   * **Confirmed:** 95% or more of uses follow the rule.
   * **Contradicted:** fewer than 50% follow it, so the team writes it differently.
   * **Mixed:** 50–95%. This may be inconsistency in the approved books; list the minority references.
   * **No evidence:** the form doesn't occur.
5. **Write the profile** (`grammar-profile.md`) with a table: Rule ID | Statement | Page | Test type | Result | Evidence (counts + 3 references) | Suggested use.
6. **Mentor verifies.** Ask the mentor to confirm Confirmed rules in bulk, and to decide each Contradicted or Mixed rule: follow the paper, or follow team practice.
7. **After verification, propose:**
   * Memory note `style/grammar-profile` with the verified rules.
   * Custom rules for verified pattern rules (forbidden or required pattern, with an autofix where safe), for the Project lead.
   * A lexical list of affixes and clitics for `qa-spelling-wordlist`, so inflected forms aren't flagged as variants.
   * A list of meaning-carrying markers (negation, plural, tense) for `qa-meaning-fidelity` to check against the source.

### Descriptive mode (no paper)

With no paper, build a profile from the approved books alone: the most frequent prefixes and suffixes (by splitting frequent words), the function words (the top 100 words by frequency), and recurring clitic patterns. Label every rule *Descriptive*. The mentor verifies it the same way.

### Do not

* Enforce a rule the mentor hasn't verified.
* Use judgment rules for anything but Queries.
* Trust the paper over the verified approved text.
