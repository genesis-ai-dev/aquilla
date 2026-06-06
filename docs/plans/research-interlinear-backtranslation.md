# Research Report: Interlinear Back-Translation & Fast Client-Side Word Alignment

**Date:** 2026-06-06  
**Context:** Codex web app — designing a deterministic, client-side back-translation + interlinear alignment system for Bible translation teams.

---

## Research Value: High

Substantial prior art exists in SIL/Paratext's Statistical Glossing Tool (SGT), the IBM Model 1 EM algorithm, and fast_align. The Paratext workflow maps closely to the UX model needed. IBM Model 1 is the clear algorithmic choice for in-browser incremental alignment at Bible-corpus scale.

---

## Part 1: How Paratext's Interlinearizer Works

### 1.1 Background and Purpose

Paratext's **Project Interlinearizer** (also called the Custom Interlinearizer) produces word-for-word back translations — a gloss under each source-language word showing what the translator rendered it as in the target language. Translation consultants use these to check faithfulness without knowing the target language.

The underlying engine is the **Statistical Glossing Tool (SGT)**, first shipped in Paratext 7 and described in the peer-reviewed paper:

> Riding, J. & Van Steenbergen, M. (2011). "Glossing Technology in Paratext 7." *The Bible Translator*, 62(2), 92–102. DOI: 10.1177/026009351106200206.

SGT was demonstrated to Translation Consultants who immediately dubbed it the **"Mystical Glossing Tool"** — a backhanded compliment that it worked surprisingly well despite limited computing resources and no target-language linguistic database.

### 1.2 The Statistical Guesser Mechanism

SGT is a **language-independent, unsupervised statistical word aligner** operating on the parallel corpus of (source verse, translator's target verse) pairs already present in the project. Key properties:

- **No linguistic resources required.** The guesser learns purely from co-occurrence of source tokens and target tokens across aligned verse pairs.
- **Model text.** A reference translation in a major language (e.g., English) is used as a pivot; the target-language translation is aligned to this reference. When there is no reference, raw co-occurrence against the source (Hebrew/Greek) is used instead.
- **EM-based.** The mechanism matches what is described in IBM Model 1: translation probabilities `P(target_word | source_word)` are learned by alternating expectation (computing expected alignment counts given current probabilities) and maximization (re-estimating probabilities from counts). Each verse pair is treated independently (the corpus likelihood factorizes per sentence pair), so partial corpora work.
- **Bias toward diagonal.** Subsequent Paratext versions added a positional prior that penalizes far-from-diagonal alignments, consistent with how fast_align extends IBM Model 1 with a single diagonal-preference parameter.

### 1.3 High-Confidence vs Low-Confidence Glosses

Paratext exposes confidence visually rather than numerically:

- **Red gloss** = unapproved / low confidence. These are the guesser's output before any user action.
- **Approved gloss** = user has confirmed (or edited) the suggestion. Color shifts.
- The system's internal ranking is the **translation probability** `P(target | source)`. Higher probability → more likely to be correct → surfaced as the top suggestion in the dropdown. The threshold between "show confidently" and "show as uncertain" is not exposed as a number to the user — it is implicit in whether the top candidate has notably higher probability than alternatives.

### 1.4 User Confirm / Invalidate Workflow

1. Paratext displays the target verse with a gloss field under each source token.
2. Guesser populates each gloss field with its top-probability candidate (shown in red = unapproved).
3. User clicks a gloss to see a ranked list of alternatives (all candidate translations ordered by `P(target | source)`).
4. User selects the correct gloss or types a free-form gloss.
5. Pressing Enter saves and marks the gloss **approved** (color change).
6. "Next Unapproved Verse" navigation lets the user work through the corpus sequentially.
7. When exporting, any remaining red (unapproved) glosses are force-approved as-is — the system does not block export.

### 1.5 Incremental Learning

SGT is not stateless. Each confirmed gloss feeds back into the translation probability table:

- When a user **confirms** `P(target_word | source_word)`, that pair's count is incremented, raising the probability estimate for that pair across the whole corpus.
- When a user **overrides** the top guess with a different word, the overridden word's count for that source token is lowered and the correct word's count is raised.
- Because the EM model is shallow (IBM Model 1 level), recomputation after a single correction is cheap: only the row in the probability table for the corrected source token needs updating. No full re-EM is required for a confirmed correction — the model can operate in a **count-table + normalize** mode between full retraining passes.
- In practice Paratext batches retraining: the model improves noticeably after 5–10 chapters are glossed, becoming "quite accurate quickly" per the official documentation.

### 1.6 Paratext Manual References

- Official manual chapter: [17. Interlinearize a project](https://manual.paratext.org/17.BT2/)
- Feature page: [Create Custom Interlinear Texts with Paratext](https://paratext.org/features/create-custom-interlinears-texts/)
- Training tutorials: [How to Open an Interlinear Window in Paratext 9.2](https://paratext.org/paratext-training/tutorials/open-interlinear-window-paratext-9-2/)
- LingTranSoft wiki (PDF): [ParaTExt: Making Back Translations With Project Interlinearizer](https://lingtran.net/display970)
- SIL SILNLP pipeline (uses eflomal for batch alignment): [github.com/sillsdev/silnlp](https://github.com/sillsdev/silnlp)

---

## Part 2: Fast Statistical Word Alignment for the Browser

### 2.1 Candidate Algorithms

#### A. IBM Model 1 (EM)

**How it works:**  
Maintains a table `t[src][tgt]` of translation probabilities. Each EM iteration:
- **E-step:** For each `(src_word, tgt_word)` co-occurring in aligned sentence pairs, compute fractional count `t[src][tgt] / Σ_t t[src][t]`.
- **M-step:** Normalize counts to get new `t[src][tgt]`.

**Complexity:** O(|corpus| × |src_vocab| × |tgt_vocab|) per full pass, but in practice O(verse_count × avg_src_len × avg_tgt_len) per iteration. For 31,000 Bible verses with avg 10 words each and 10 EM iterations, this is on the order of 10–100M floating-point operations — well within browser capability in a Web Worker.

**Convergence:** Typically 5–15 full-corpus EM iterations. Each iteration over a 31k-verse Bible corpus runs in ~200–800 ms in a modern JS runtime (V8) based on algorithmic complexity; real numbers from Python reference implementations suggest ~1–5s for the full Bible, likely faster in optimized JS with typed arrays.

**Output:** `t[src][tgt]` is a direct probability, usable as confidence. Threshold at `t > 0.5` for "high-confidence"; `t > 0.3` for "show suggestion, require confirmation".

**Incremental update:** The count table can be updated online:
```
// On user confirm of (src_token → tgt_token):
count[src_token][tgt_token] += LEARNING_RATE
// Renormalize row for src_token only
t[src_token] = normalize(count[src_token])
```
This is O(|src_vocab_for_that_token|) — essentially free.

**Verdict:** **Best choice for in-browser TypeScript.** Simple, interpretable, probabilistic output, incremental-update-friendly, no native dependencies.

#### B. fast_align (Dyer et al., 2013)

**How it works:**  
A log-linear reparameterization of IBM Model 2. Adds a single diagonal-preference parameter `λ` that penalizes alignments far from the diagonal. Trained with EM. Notably 10× faster than IBM Model 4 (GIZA++) and comparable in accuracy.

**Suitability for browser:** fast_align is a C++ binary. No JS/WASM port exists as of 2026. However, the *algorithm* can be implemented in TypeScript — it is effectively IBM Model 1 + one scalar parameter. The positional bias makes it better than pure IBM Model 1 for languages with different word order.

**Verdict:** Implement the fast_align-style diagonal prior on top of IBM Model 1. This is a ~5-line addition.

**Reference:** [github.com/clab/fast_align](https://github.com/clab/fast_align); paper at [kilthub.cmu.edu](https://kilthub.cmu.edu/articles/journal_contribution/A_Simple_Fast_and_Effective_Reparameterization_of_IBM_Model_2/6472985/1)

#### C. eflomal (Östling & Tiedemann)

**How it works:**  
Bayesian MCMC aligner with HMM and fertility models. Dirichlet priors. Processes one sentence at a time (low memory). Supports prior-based incremental alignment by generating a prior from a large corpus and applying it to new sentences.

**Performance:** Aligned 1.13M sentence pairs in 337 seconds (C binary). Outperforms fast_align on most language pairs. Memory-efficient.

**Suitability for browser:** C codebase with Cython bindings. No JS/WASM port. The MCMC approach does not lend itself to simple TypeScript reimplementation.

**Verdict:** Use eflomal server-side if a server-side batch alignment step is acceptable (e.g., initial cold-start seeding of the probability table). Not suitable for in-browser incremental updates. SIL's SILNLP pipeline uses eflomal for exactly this batch step.

**Reference:** [github.com/robertostling/eflomal](https://github.com/robertostling/eflomal)

#### D. Simple Co-occurrence: Dice / PMI

**How it works:**  
- **Dice:** `2 * count(s,t) / (count(s) + count(t))`
- **PMI:** `log(P(s,t) / (P(s) * P(t)))`

Both are O(1) update per new verse pair. No EM required.

**Quality:** Baseline quality. Dice is the standard SMT baseline and works reasonably well for common words but misses function words and morphological variation. PMI favors rare co-occurring pairs, leading to spurious alignments on low-frequency words.

**Verdict:** Use Dice as a **cold-start warm-up** before EM converges. On the first few commits (< 10 verse pairs), Dice gives reasonable guesses faster than EM. Transition to IBM Model 1 once 50+ verse pairs are available.

#### E. Markov-Chain / N-gram Alignment

HMM-based alignment (IBM Model 3/4 territory) adds transition probabilities between alignment positions. Significantly more complex, much slower, and not meaningfully better than fast_align at Bible-corpus scale. Not recommended for in-browser use.

### 2.2 Algorithm Comparison Table

| Algorithm | Output | Cold-start quality | Incremental update | Browser-viable | Confidence score |
|---|---|---|---|---|---|
| IBM Model 1 (EM) | `P(tgt\|src)` ∈ [0,1] | Poor < 20 pairs; good > 100 | Online count update | **Yes** | Direct probability |
| IBM M1 + diagonal prior (fast_align style) | `P(tgt\|src)` × positional | Slightly better alignment | Same as M1 | **Yes** | Direct probability |
| eflomal | Posterior alignment | Excellent | Prior-based only | No (C/MCMC) | Marginal posterior |
| Dice co-occurrence | Dice ∈ [0,1] | Reasonable | O(1) update | **Yes** | Overlap coefficient |
| PMI | PMI ∈ (-∞,+∞) | Poor for rare pairs | O(1) update | **Yes** | Needs calibration |

### 2.3 Recommended Architecture for Codex

#### Data Structures (TypeScript)

```typescript
// Translation probability table: src_token → tgt_token → probability
type ProbTable = Map<string, Map<string, number>>;

// Raw co-occurrence counts (kept separate for online updates)
type CountTable = Map<string, Map<string, number>>;

// Per-verse alignment: src_index → tgt_index → confidence
type AlignmentMatrix = Map<number, Map<number, number>>;
```

#### Cold-Start Strategy (0–50 verse pairs committed)

Use **Dice co-occurrence** as the sole signal. For each new cell commit (source verse + translated verse):
1. Tokenize both sides (whitespace + punctuation split; optionally lowercase).
2. For each `(src_token, tgt_token)` pair that co-occur in the verse, increment `count[src][tgt]`, `count_src[src]`, `count_tgt[tgt]`.
3. Compute Dice for each candidate pair on-demand when a gloss is needed.
4. Threshold: suggest if `Dice > 0.15`; mark high-confidence if `Dice > 0.4`.

Dice updates are O(src_len × tgt_len) per verse — trivially fast.

#### Warm Phase (50+ verse pairs: EM kick-in)

Run IBM Model 1 EM in a **Web Worker** so it does not block the UI:
1. On each cell commit, add the new pair to a corpus buffer.
2. Every N commits (suggest N=10 or time-triggered every 60s), post the full corpus to the worker.
3. Worker runs 10 EM iterations over the full corpus (typically < 1s for a few hundred verse pairs).
4. Worker returns updated `ProbTable`. Main thread merges it.
5. For the committed verse specifically, compute `AlignmentMatrix` immediately using current `ProbTable` (greedy argmax over `t[src][tgt]` for each src token).

#### Online Update After User Confirmation

When a user **confirms** or **overrides** a gloss:
```typescript
function onGlossConfirmed(src: string, tgt: string, approved: string) {
  // Increment approved pair
  increment(countTable, src, approved, CONFIRM_WEIGHT); // e.g., CONFIRM_WEIGHT = 5
  // Decay old top candidate if different
  if (approved !== tgt) {
    decrement(countTable, src, tgt, 1);
  }
  // Renormalize only this src token's row
  normalize(probTable, src, countTable);
  // Re-score glosses for all verses containing this src token (debounced)
  rescoreVersesContaining(src);
}
```
`CONFIRM_WEIGHT = 5` gives confirmed glosses 5× the weight of a single co-occurrence, matching Paratext's behavior where confirmed glosses rapidly dominate the suggestion.

#### Confidence Thresholding

Following the Paratext model (red = unapproved, colored = approved) mapped to numerical thresholds:

| State | Condition | UI treatment |
|---|---|---|
| No suggestion | `max(t[src][*]) < 0.1` | Empty gloss field, cursor prompt |
| Low confidence (show but flag) | `0.1 ≤ t < 0.3` | Shown in amber/italic, requires confirmation |
| Medium confidence | `0.3 ≤ t < 0.6` | Shown in default style, one-click confirm |
| High confidence (auto-approve candidate) | `t ≥ 0.6` | Shown bold, can bulk-approve per verse |

Do not auto-approve high-confidence glosses without user action. Show them as "pre-filled but still needing one confirm click." This matches Paratext's philosophy.

#### Positional Diagonal Prior (fast_align extension)

Add to IBM M1 alignment score:
```typescript
// lambda ≈ 4.0 works well for Bible (short-ish verses, moderate word-order divergence)
const lambda = 4.0;
const diagonalScore = Math.exp(-lambda * Math.abs(srcPos/srcLen - tgtPos/tgtLen));
const alignScore = probTable.get(srcToken)?.get(tgtToken) ?? 1e-9;
const combined = alignScore * diagonalScore;
```
This breaks ties in favor of monotone alignment, which is appropriate for Bible text where Greek/Hebrew → English word order diverges but verse-internal alignment is roughly monotone.

---

## Part 3: Confirm / Invalidate UX Model (Grounded in Paratext)

### 3.1 Paratext's Model (Abstracted)

Paratext's workflow, reduced to principles:

1. **Every gloss starts unapproved.** The system never asserts an alignment is correct — only that it is the best current guess.
2. **Approval is explicit, per-gloss.** The user must act (click + confirm) to mark a gloss approved. Bulk verse approval is a shortcut, not the default.
3. **Override = implicit feedback.** When the user chooses a different word than the top guess, the system treats this as a training signal.
4. **"Next unapproved" navigation.** The user is guided through unconfirmed glosses, not through verses sequentially. This surfaces uncertainty efficiently.
5. **Export-time force-approval.** Unapproved glosses are exported as-is when the user explicitly exports; the system doesn't prevent completion.

### 3.2 Recommended UX for Codex

**Per-cell (verse) interlinear display:**
- Source tokens shown as blocks.
- Under each source block: a gloss chip.
- Chip states: `empty` | `suggested-low` | `suggested-high` | `confirmed` | `invalidated`.

**Interactions:**
- **Click chip** → open picker: ranked list of candidates (top 5 by probability) + free-text input.
- **Press Enter on top candidate** → confirm (chip state → `confirmed`).
- **Select different candidate** → confirm that one; increment count for chosen, decrement for previous top.
- **Mark as 'no equivalent'** → `invalidated` state; src token marked as function word / untranslatable.
- **Bulk confirm verse** → available only when all chips are `suggested-high` (confidence ≥ 0.6).
- **"Next unconfirmed gloss"** keyboard shortcut to navigate across verses.

**Feedback loop:**
- Every confirmation triggers an online count update (O(1), synchronous on main thread).
- Full EM re-run in Web Worker is debounced (triggered every 10 confirmations or 60s of inactivity).
- After EM re-run, all chips in open views are re-scored without losing `confirmed` states (confirmed glosses are not overridden by re-scoring).

### 3.3 Handling the Cold-Start Problem

When a project has fewer than 20 committed verse pairs:
- Rely on **cross-project transfer**: if a reference alignment table exists (e.g., from a Hebrew/Greek→English model), seed the `ProbTable` with it scaled by 0.1. This gives the guesser a head start using known mappings.
- If no reference exists, show empty gloss fields with "translate to unlock suggestions" messaging. Do not show random guesses.

---

## Part 4: Implementation Roadmap

### Phase 1: Cold-start Dice (Sprint 1)
- Implement tokenizer (whitespace + punctuation, lowercase, strip diacritics flag).
- Implement Dice co-occurrence count table (persisted to IndexedDB).
- On each cell commit, update counts + surface top-3 Dice candidates per source token.
- Gloss chip UI with confirm/override.

### Phase 2: IBM Model 1 EM in Web Worker (Sprint 2)
- Web Worker running 10-iteration EM on corpus snapshot.
- Probability table replaces Dice table for confident suggestions.
- Online count update on confirm.
- Confidence thresholds → chip state machine.

### Phase 3: fast_align diagonal prior (Sprint 3)
- Add positional score to alignment during per-verse decoding.
- Tune `lambda` on a held-out Bible book.

### Phase 4: Cold-start seeding from reference model (Sprint 4)
- Bundle a pre-computed Hebrew/Greek→English probability table (compressed JSON, ~2MB).
- Use as prior with weight 0.1 to warm-start new projects.

---

## Sources

- [17. Interlinearize a project | Paratext Manual](https://manual.paratext.org/17.BT2/)
- [Create Custom Interlinear Texts with Paratext](https://paratext.org/features/create-custom-interlinears-texts/)
- [How to Open an Interlinear Window in Paratext 9.2](https://paratext.org/paratext-training/tutorials/open-interlinear-window-paratext-9-2/)
- [Riding & Van Steenbergen (2011) "Glossing Technology in Paratext 7" — The Bible Translator 62(2)](https://translation.bible/wp-content/uploads/2024/06/riding-van-steenbergen-2011-glossing-technology-in-paratext-7.pdf) — primary description of SGT algorithm and its statistical foundations
- [ParaTExt: Making Back Translations With Project Interlinearizer — LingTranSoft](https://lingtran.net/display970) — practitioner workflow description
- [Paratext_8_3-6_Stage3 — LingTranSoft Wiki](https://lingtran.net/Paratext_8_3-6_Stage3) — stage-3 workflow including interlinearizer confirmation steps
- [GitHub: clab/fast_align](https://github.com/clab/fast_align) — fast_align source; log-linear IBM Model 2 reparameterization
- [Dyer et al. (2013) "A Simple, Fast, and Effective Reparameterization of IBM Model 2" — KiltHub CMU](https://kilthub.cmu.edu/articles/journal_contribution/A_Simple_Fast_and_Effective_Reparameterization_of_IBM_Model_2/6472985/1) — fast_align paper; 10× faster than Model 4
- [GitHub: robertostling/eflomal](https://github.com/robertostling/eflomal) — Bayesian MCMC aligner; best quality for batch offline alignment
- [GitHub: sillsdev/silnlp](https://github.com/sillsdev/silnlp) — SIL's NLP pipeline, uses eflomal for production word alignment
- [IBM Model 1 implementation (gist, hans/9082054)](https://gist.github.com/hans/9082054) — reference Python implementation of EM for IBM Model 1
- [Collins (2011) "Statistical Machine Translation: IBM Models 1 and 2" — Columbia/Stanford](https://www.cs.columbia.edu/~mcollins/courses/nlp2011/notes/ibm12.pdf) — authoritative mathematical description of IBM Model 1 EM
- [Word Alignment in the Era of Deep Learning: A Tutorial (2022)](https://arxiv.org/pdf/2212.00138) — survey comparing IBM models, fast_align, eflomal, SimAlign
- [Graph Algorithms for Multiparallel Word Alignment (2021)](https://arxiv.org/pdf/2109.06283) — multiparallel alignment; relevant for multi-source Bible data
- [Online Word Alignment for Online Adaptive Machine Translation — ResearchGate](https://www.researchgate.net/publication/270877731_Online_Word_Alignment_for_Online_Adaptive_Machine_Translation) — online EM update rule; basis for incremental-update strategy
