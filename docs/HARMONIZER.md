# Harmonizer — cross-cell checks by metafunction

A translation can be right verse by verse and still not read as one text. A
quotation opens and never closes. A new speaker arrives as "he". A connective
contradicts the one before it. These are failures of the **textual
metafunction** (SFL): the resources a language uses to turn clauses into
discourse. Drafting one cell at a time makes them more likely, and no
per-cell check can see them.

The harmonizer is a set of independent checks in `src/lib/harmonizer/`, run
together on the passage around the active cell. Their suggestions appear
beside smart edits.

## The rule every check follows

**The obligation comes from the source. The realization comes from the project.**

- *What the text requires* is language-general and read from the source by
  Jev. For example: the speech ends in v.27, the subject changes in v.38, and
  v.29 gives the reason for v.28.
- *How the target expresses it* is never assumed. That includes which marks
  quote, whether a switched subject takes a name, a pronoun, a
  switch-reference suffix or nothing, and which connective marks a reason.
  Each check learns it from the project's own text, validated cells first.
  This matters most for a low-resource language, where a model's defaults are
  English defaults.

## Shape of a check (`HarmonyCheck`)

| Step | Kind | Does |
|---|---|---|
| `plan` | deterministic | Learns the project's realization and finds the places worth asking about. Returns null when there is nothing to ask, and then no call is made. |
| `questions` | Jev | **Atomic** `noul` and `choice` questions. Each one asks a single fact about one side. TypeSafe measured 95% accuracy for atomic questions combined in code, against 62.6% for one broad question. |
| `findings` | deterministic | Combines the answers into exact-span suggestions. A missing or uncertain answer produces nothing. |

`runner.ts` merges every check's questions into **one Jev call per passage**.
Each check's questions carry their own prefix, `h<n>_`.

A finding is either a **replacement** (old → new, with Accept) or a **flag**
(`flagOnly`: an underline with a reason and Dismiss only). Flags are for
problems whose fix is a wording choice, such as which name or noun phrase to
use. A rule must not guess wording; that is a model's job, on request.

## Inventory: what a polished discourse needs

Status: **built** = in a PR; otherwise ordered by value ÷ cost.

### Projection (speech and thought)
1. **Quotation closes where the speech ends.** *Built*: `textual.quotation`, AQU-1657.
   It learns the project's quote pair and finds broken or open quotations.
   Jev picks the cell where the speech ends and whether it ends at the end of
   that cell. Next: a speech that ends mid-verse (an LLM fix), a quotation
   that never opens, nested quotations.
2. **Speech-introduction formulas** are consistent across a dialogue, for
   example "answered and said" against "replied", where the project shows a
   preference in validated text.
3. **Speaker attribution in long dialogues.** In an exchange of turns, every
   turn's speaker is recoverable. This is reference at turn boundaries (item 4).

### Participant reference (tracking who is on stage)
4. **Under-specification at a subject switch.** *Built, not registered*:
   `textual.reference`, AQU-1658. **It failed the eval.** Jev's "would a
   reader identify the subject" answer averaged 0.83 on original verses and
   0.72 after the name became "he", and never went below 0.5. Every cut-off
   either stays silent or flags about 0.6 clean boundaries per passage.
   Redesign: ask a `choice` over the passage's named participants ("who would
   a reader take the subject to be?") and compare it in code with the
   source's answer, instead of asking Jev to judge clarity. Jev answers three questions: did the source subject switch? Would
   a reader of the target identify the right participant? Which word refers to
   the subject? It flags the word when the subject switched and a reader would
   misidentify it.
5. **Over-specification.** A continuing subject is renamed where this project
   uses a pronoun or nothing. This needs a learned profile: how often the
   validated text renames a continuing subject, at a paragraph start and in
   the middle of a paragraph.
6. **Participant introduction.** A first mention uses the project's
   introducing form ("a man named Nicodemus", or a presentational
   construction). A later mention uses the tracking form, not the
   introduction again.
7. **Coreference chains.** One referent stays one referent across the
   passage: pronoun agreement in gender, number and honorific level, and no
   drift between forms (Yesu / Yesus). For Bible sources, Macula Greek and
   Hebrew carry referent IDs, which give the source chain without Jev. Jev
   then only judges the target side.

### Conjunction (how clauses relate)
8. **Connective relation matches the source.** *Built*: `textual.connective`,
   AQU-1676. 45% recall at 0.6, with one false alarm in 200 clean passages. The eval
   changed the rule from "the relations differ" to "the target **reverses**
   the source": reason ↔ inference, or contrast → inference. A weak source
   relation (καί, narrative δέ) is rendered "When", "So" or "But" all the
   time in good translation, and it produced every clean-text alarm. The
   original design text follows. γάρ gives a reason, οὖν an
   inference, δέ a development or contrast, καί an addition. Jev classifies
   the source relation at each boundary and whether the target's connective
   expresses it. The project's connective inventory is learned from validated
   cells.
9. **Connective density.** "And… and… and" chains that the target language
   would not use. This compares the validated-text rate per cell with the
   draft's rate.

### Sentence and paragraph continuity
10. **Sentence continuity at a seam.** *Built*: `textual.sentence`, AQU-1659.
    Splitting a long source sentence is often good translation, so a split
    alone is never flagged. What is flagged is a target that does not hold
    together:
    - **Full stop then lowercase.** Deterministic, no Jev.
    - **Full stop mid-sentence.** The source runs on, and Jev judges that
      the target sentence is incomplete.
    - **No closing punctuation.** The source sentence ends here and the
      target does not carry it on. The fix adds the project's own
      terminator, learned from its validated cells.

    The source question is the seam classifier's `continues_sentence`, word
    for word, so the two features can be measured together. It cannot reuse
    cached seams: they store only the combined join decision, and seam
    classification is off by default.
11. **Paragraph and section openings** use the project's
    point-of-departure style ("After this,", "Then") and heading
    conventions.

### Deixis
12. **Person deixis in speech.** Inclusive or exclusive "we" stays consistent
    through a speech. Many languages must choose one, and a cell-by-cell
    draft chooses at random. I/you stay consistent across a long speech.
13. **Spatial and temporal deixis.** this/that, here/there, come/go and
    now/then fit the narrative's deictic centre across cells.

### Grounding, theme and information
14. **Tense and aspect across the narrative backbone.** For example, the
    Greek historical present is rendered consistently, and backbone and
    background events keep the project's tense pattern.
15. **Thematic progression.** Clause-initial elements keep the topic
    continuous where the source does.
16. **Focus and fronting.** Source emphasis keeps some realization. This
    overlaps the interpersonal metafunction.

### Lexical cohesion
17. **Repetition chains the source builds on purpose.** For example
    ἔργον / ἐργάζομαι across John 6:27–29 ("work for… the work of God"),
    rendered with related target words rather than unrelated synonyms.
    Key-term consistency belongs with the termbase (ideational).

## Cross-cutting work

- **Realization profiles.** Several checks (5, 6, 8, 9, 11) need a learned
  per-project profile. Compute it once per project from validated cells,
  cache it, and pass it to `plan` instead of having each check relearn it.
- **Eval results** (`pnpm harmonizer:eval`, BSB + Macula, MAT–ACT, 40 cases
  per check, typesafe/jev-1.13, 2026-10-05). Shipping thresholds are in
  bold.

  | Check | Recall | False alarms per clean passage |
  |---|---|---|
  | sentence: run-on | **88%** (0.6) | 0.03 |
  | quotation close (broken spans only) | **38%** (0.6) | 0.07 |
  | sentence: broken-off | **18%** (0.6) | 0.00 |
  | connective reversal | **45%** (0.6) | 0.005 |
  | reference (unregistered) | 28% | about 0.55 from this check alone |

  The first run scored far lower, for two reasons:
  - Unfair perturbations: a speech that opened before the window, or a
    "fragment" that was really a complete sentence.
  - Two rules the data contradicted: asking about quotations still open at
    the window edge (most clean-text alarms), and a 0.7 source gate that
    rejected real fragments.

- **Eval harness.** Take validated passages, perturb them (drop a closing
  quote, replace a name with "he" after a switch, swap a connective), and
  measure how many the check recovers and how many it flags falsely. Run it
  before any check's flag defaults on. Thresholds (0.6 and 0.7 today) come
  from this eval, not intuition.
- **Audit trail.** Record every shown, accepted and dismissed suggestion in
  `ai_interventions` (AQU-1656), with the Jev questions and answers as the
  trace.
- **Auto-fix (Phase 3).** Only replacements are eligible, never flags, and
  only on unvalidated or AI-drafted cells. Validated cells only ever get
  suggestions.
- **Interpersonal** (register, honorifics, forms of address, mood) and
  **ideational** (key terms, participant roles) checks use the same
  `HarmonyCheck` shape.
