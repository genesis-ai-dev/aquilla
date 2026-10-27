# Two-step transcription: a Transcribe mode, ASR then LLM cleanup, lane transcription rules

Status: design draft, 2026-10-23. No ticket yet. Not built.
This replaces the earlier draft of this file, which put the cleanup in a Smart
Extension. Ryder's direction (2026-10-23): build it into the editor, the same
way target prediction works.

## Goal

ASR for a low-resource language gets the same things wrong again and again.
People fix them by hand, take after take. This work makes the fix happen once:

1. A **Transcribe mode** in the editor. The left column shows the audio and what
   the machine heard. The right column is the transcript you are working on.
2. The **sparkle** on the right runs two steps: ASR (any model), then an LLM
   cleanup that follows the way this project has already corrected transcripts.
3. Each language lane has **transcription rules**. Approved rules are applied
   before the LLM sees the text, and are given to it as instructions.
4. A **pattern miner** reads the lane's corrections. Jev decides cheaply which
   candidate patterns are worth keeping. An LLM is called only for those, to
   write each one as a rule. A person approves every rule.

This is the smart-edits design (`auth-worker/src/routes/ai-smart-edits.ts`)
applied to transcripts: memory first, then Jev, then the LLM only when needed.

## What exists today

| Piece | Where | Gap |
|---|---|---|
| ASR on a source segment or a take | `transcribeCell`, `src/lib/audio/transcribe.ts` | What ASR heard is overwritten by the first correction |
| Learned word fixes (AQU-463) | `src/lib/audio/transcript-corrections.ts` | One word for one word only. Stored in localStorage on one device. No lane. No approval |
| Sparkle draft | `TargetDraftActions` → `useCompletion.completeSingle` → `commitCompletedCell` | Drafts a translation of the source. Has nothing for transcripts |
| Few-shot pairs | `collectValidatedPairs`, `selectApprovedExamples` | Pairs are source → target, not heard → corrected |
| Lane rules | `TranslationRule` with `scope: "lane"`, `rulesForLane` (`src/lib/rules/rule-engine.ts:40`) | Rules are checks. Only `autofix: regex-replace` changes text. Nothing marks a rule as being for transcripts |
| Proposed → approved rules | Style-rule library (AQU-934), `StyleRuleCandidates.tsx` | No `lane` field |
| Smart-edit miner, Jev, LLM on click | `auth-worker/src/lib/smart-edits/miner.ts`, `src/lib/smart-edits/jev-request.ts`, `/llm` route | Reads target commits, not transcripts |

## 1. Save what the machine heard

Everything below needs pairs of "ASR heard X" and "a person settled on Y".
We do not keep X today.

- Migration: add `asr_text TEXT`, `asr_model TEXT`, `asr_at TIMESTAMPTZ` to
  `cell_audio`, and the same three to `cells` for source segments (their
  transcript lives in `cells.transcription`).
- `cell.audio.attach` gains an optional `asr: { text, model }`. Only the ASR
  path sends it (`transcribe.ts:609`). Corrections never send it, and the
  projection keeps the stored value when the field is missing.
- `asr_text` is the text **before** any rule or learned fix is applied, so a
  pair always shows the real ASR error.

A transcript counts as **corrected** once a person has edited or validated it.
A corrected transcript with an `asr_text` is a **pair**. Transcripts from
before this ships have no `asr_text`. They still count as corrected examples,
but not as pairs.

## 2. Transcribe mode

A third lens in `EditorModeToggle`: **Text · Audio · Transcribe**. It is stored
with the other lens preferences (`useEditorLensPreference`) and is offered only
when the file has audio: media source segments or recorded takes.

Each row:

| Left column (read-only) | Right column (the transcript) |
|---|---|
| Play, with the take's trim. A short waveform. | The transcript, editable. Saving is a transcript correction: timings are remapped (`remapTranscriptTimings`) and the edit is recorded as a pair. |
| **Heard**: `asr_text`, muted. "Not transcribed yet" when empty. | The **sparkle**, in the same rail slot as the target draft sparkle. |
| The model that produced it, on hover only. | A small "Cleaned up · N changes" mark on an AI result, cleared by any human edit or by validation. Changed words are underlined. Hover shows the heard word. |

Which transcript a row edits:

- **Source segment** (`isSourceSegmentSelected`): the cell's source
  transcription, in the **source** lane's language. Editing it already writes
  `cells.transcription`, and translation drafts already read it
  (`effectiveSourceText`).
- **Recorded take**: the selected take's transcript, in that **target** lane's
  language.

Transcribe mode never writes the target translation text. "Use as line text"
(`onUseAsCellText`) stays where it is today, in the Text lens.

Filters in the mode's toolbar: all, not transcribed, AI-cleaned and not yet
reviewed, corrected, validated.

## 3. The sparkle: transcribe, then clean up

One press on a row:

1. **ASR.** If the row has no `asr_text`, or its audio changed since, run
   `transcribeCell` with the user's chosen model (automatic, Omni CTC, ZS…).
   Store `asr_text`.
2. **Rules.** Apply the lane's approved transcription rules (section 4) to the
   heard text. This step is code, not a model.
3. **Cleanup.** Call a new auth-worker endpoint,
   `POST /api/v1/ai/transcript-cleanup`, with:
   - the text after step 2;
   - up to 8 pairs from the same lane, picked by word overlap with this text,
     with corrected-only transcripts as a fallback;
   - the lane's approved rules, as instructions;
   - the project's key terms for that language;
   - for a source segment only, nearby source transcripts as context.

   The endpoint runs the project's default model, is billed through
   `runAiGuard` and the weekly ledger like `/llm`, and returns the cleaned
   text plus up to 10 `{ heard, wrote, reason }` notes.
4. **Land it** as an AI result on the transcript: remap timings, set the
   AI-cleaned mark, and record provenance (model, rule ids, example ids). It is
   never validated by the sparkle.

Regenerate (the rail's existing second action) re-runs step 3 only. A
long-press, or the menu, re-runs from step 1.

**Batch:** "Transcribe and clean up" for the selected rows or the chapter,
through the existing batch-draft modal. It shows the zero-shot credit estimate
when ZS is the model, plus the cleanup's own estimate.

### Guardrails

- **A recorded take never sends the line's written text.** Comparing a take's
  transcript to the line is how we catch misreadings
  (`src/lib/audio/transcript-verdict.ts`). If the LLM sees the line, it will
  "correct" the transcript towards it and hide them.
- **Human work wins.** The sparkle is refused on a validated transcript. On a
  corrected one it asks first, the same way target drafts treat human text.
- **No new words.** The prompt says to keep what was spoken. The endpoint
  rejects a result whose word count differs from the heard text by more than
  25%, and the row shows "Cleanup changed too much".

## 4. Lane transcription rules

A transcription rule is a `TranslationRule` with:

- `scope: "lane"` and `lane` set to the language lane;
- a new `appliesTo: "transcript"` (default `"target"` for every existing rule);
- `autofix: { kind: "regex-replace", pattern, replacement, flags }`, for rules
  code can apply. A rule with no autofix is an instruction to the LLM only
  (for example "join the locative -ni to the noun before it").

`rulesForLane` gains an `appliesTo` filter. Target checks and translation
prompts ignore transcript rules, and transcript cleanup ignores the rest.

People can write rules by hand in the existing rules surface, under a new
**Transcription** group, filtered to the lane.

The AQU-463 learned word fixes move here. On first load per device, each local
fix that has been made at least twice is offered as a proposed rule for the
project's lane. After that, the local store is no longer written to or read.

### Proposed → approved

Mined rules are proposals. They go through the style-rule library's gate
(AQU-934: proposed, approved, rejected, with examples and who reviewed them).
That library has no lane today, so this adds `lane` and `appliesTo` to it.
Approving a proposal writes the `TranslationRule` above. See open question 1.

## 5. Mining transcription patterns

Mirrors the smart-edit miner, tier by tier.

**Tier 0: memory, plain code.** A server-side miner in auth-worker folds pairs
into a `transcript_observations` table, per `(project, lane)`. It runs
incrementally, like `miner.ts`. From each pair it records, after alignment:

- whole-word substitutions (`eema → Yesu`);
- joins and splits (`kwa mji → mjini`, `sinagogi ni → sinagogini`);
- character-level changes that repeat across different words
  (`c → ch`, a dropped apostrophe).

It counts how often each pattern was made, kept, undone or contradicted, and
scores it the way `scoreCandidates` does. Anything below the `verify` level is
dropped. The miner runs when a lane has 5 new pairs since its last run, or when
someone presses **Find patterns** in the Transcription rules group.

**Tier 1: Jev.** All `verify` candidates for a lane go to Jev in one batched
`choice` request (cap 24, `jev-request.ts`). Each question shows the candidate
and up to 3 pairs that support it, and asks for one of:

- `rule`: a consistent spelling or segmentation rule for this language;
- `term`: one name or word, better kept as a key term;
- `noise`: a one-off or an ASR glitch;
- `unsure`.

Only `rule` and `term` picks at a probability of 0.6 or more go on. Jev calls
are not billed in credits. They have a per-project cap, like `decide.ts`.

**Tier 2: LLM.** One call per mining run, with only the candidates Jev kept,
grouped. The LLM writes each one as a rule: a name, a one-line description,
an autofix pattern if one fits, and 2 or 3 example pairs. The output is
checked by code. A pattern that does not reproduce its own examples is
dropped. A `term` becomes a proposed key term instead. Billed like cleanup.

**Review.** Proposals show in the Transcription rules group with their
examples and counts. A person approves, edits or rejects. Rejected patterns
are remembered so the miner does not propose them again.

**Applying rules (separate from mining).** Approved rules with an autofix run
in step 2 of every sparkle. When a rule's pattern matches in a context it has
never been seen in, the sparkle asks Jev whether it applies there (`apply` or
`skip`), the same way smart edits ask Jev to verify. Rules without an autofix
only reach the LLM as instructions.

## Phases

| Phase | Ships | Depends on |
|---|---|---|
| P0 | Save `asr_text`. Transcribe mode with Heard and editable transcript. Sparkle = ASR + LLM cleanup with lane pairs and key terms. Batch. | — |
| P1 | Lane transcription rules: `appliesTo`, hand-written rules, autofix in step 2, migrating AQU-463 fixes | P0 |
| P2 | Miner, Jev triage, LLM rule naming, review gate with lanes | P1, and enough pairs saved by P0 |

P0 is useful on its own and starts collecting the pairs P2 needs. That is the
reason to ship it first.

### What P0 built, and where it differs from the design above

Built on `ryder/two-step-transcription`, 2026-10-23:

- `asr_text`, `asr_model` and `transcript_ai` are columns on `cell_audio` only
  (migration 0186). Source segments have a `cell_audio` row too, so the
  `cells` columns in §1 were not needed. A source-editor commit of the
  transcription clears the segment's `transcript_ai`.
- The cleanup endpoint is `POST /api/v1/ai/transcript-cleanup`
  (`auth-worker/src/routes/ai-transcript-cleanup.ts`). The prompt and parser
  are shared in `src/lib/transcript-cleanup/prompt.ts`.
- **Pairs come from the open file**, not the whole lane: the rows the lens
  already has loaded. A lane-wide read is a P1 follow-up.
- **Batch is ASR only.** "Transcribe all" in the lens toolbar runs speech
  recognition on every row with nothing transcribed yet (never a validated
  take), three at a time, and waits out the per-user limit. It has Stop. The
  cleanup stays a person's call: the sparkle on one row, or tick rows
  (Shift-click ticks a range) and "Clean up N lines". A ticked row a person
  corrected asks first. No batch-draft modal or credit estimate yet.
- **Clear is on the left.** The eraser beside the Heard text clears what ASR
  heard and the transcript built on it (an attach with an empty `asr` text and
  `timings: []`; both columns COALESCE, so empty values, not NULL). Emptying the
  transcript on the right goes back to the Heard text and teaches no word fix.
- **A failure names its step** — "Transcription failed", "Cleanup failed",
  "Couldn't save" — with the reason on hover, and goes to error tracking.
  `transcribeCell` never throws, so the ASR step reads its error from the
  transcribe-status store; before this, an ASR failure read "No speech heard".
- **The lens warms Omnilingual CTC as it opens** when a row routes there, and
  shows "Starting the speech model…" until `/status?model=ctc` says ready. The
  Modal service tracks CTC state the way it tracks ZS, and CTC may run on an
  A10G when no L4 is free.
- **The Transcribe tab is always shown.** A file with no audio shows an empty
  state instead of hiding the tab.
- Changed words are not underlined yet. The "Cleaned up · N changes" mark and
  the Heard column carry that for now.
- Alt-click on a row's sparkle re-runs ASR from scratch (the "long-press" of
  §3).
- Hand edits in the lens and in the take card share one save path
  (`src/lib/transcript-cleanup/save.ts`). A hand edit still teaches the
  AQU-463 local word fixes. An AI cleanup does not.

## Testing

Per `AGENTS.md`. The cases that carry the intent:

- A human correction leaves `asr_text` as it was.
- `asr_text` holds the text from before rules and learned fixes.
- The cleanup prompt for a recorded take never contains the line's text.
- The sparkle is refused on a validated transcript.
- A cleanup that changes the word count keeps timings over the take's original
  time range.
- A result more than 25% longer or shorter than the heard text is not saved.
- Transcript rules do not show in target checks or translation prompts, and
  target rules are not applied to transcripts.
- The miner proposes a rule from 3 consistent pairs, and proposes nothing from
  one pair or from contradicting pairs.
- A Jev `noise` pick never reaches the LLM step.
- A mined autofix that does not reproduce its own examples is dropped.
- E2E: import audio, open Transcribe mode, press the sparkle with a stubbed
  ASR and LLM, see Heard and the cleaned transcript, edit it, reload, and see
  the pair counted for the lane.

## Out of scope

- Writing transcripts into the target translation text.
- Sending audio to the LLM.
- Cleanup during live recording.
- Org-wide transcription rules. They are per lane in one project. Copying them
  between projects can come later.

## Open questions

1. Proposals: extend the style-rule library with `lane` and `appliesTo` (this
   draft), or give `TranslationRule` its own `proposed` status? The library
   already has examples, review and rejection memory.
2. Should a kept AI cleanup count as a pair for future examples and mining? If
   yes, the LLM partly learns from itself. This draft says a cleanup counts
   only once a person edits or validates it.
3. Are 8 pairs per prompt the right number? `ai.generate`-sized prompts allow
   roughly 8 to 10 short takes.
4. When the target text exists and a take is a reading of it, should Transcribe
   mode show the line next to the transcript, for the reviewer only and never
   for the model?
