# Jev shadow eval: Bible data questions (AQU-1701)

The shadow eval of the eight Bible data questions that autopilot and "Check with Bible data" ask Jev (design doc §9.3, §10). Each question was asked of published text, the World English Bible New Testament, where a "yes" is right, and of the same verses with a planted error, where a "no" is right. Every question stays in shadow in this branch: `BIBLE_QA_MODES` is unchanged, and changing it is a separate, reviewed change.

Script: `scripts/jev-shadow-eval.ts` (harness arithmetic in `scripts/lib/jev-shadow-eval.ts`, cases in `scripts/lib/jev-shadow-eval-cases.ts`, planted errors in `scripts/lib/bible-mutations.ts`).

## Summary

- **Spend, all live runs together:** 711 calls (cap 2000 per run, never reached), $0.0931 as the responses reported it. The runs were a 3-call smoke test, two full runs in production's state (197 calls each), and two ablations (157 calls each). The two full runs agreed within one or two points: speaker recall 60% and 61%, referent recall 59% and 60%, C1 the same in both.
- **C1 (Translation Questions) passes the ship gate.** At certainty ≥ 0.4, precision is 94% and recall 100%. The planted errors were easy: answers taken from another book.
- **Most of the per-cell questions answer about the source, not the translation.** Production's state carries each cell's source text and facts line ("the source is negated", '"you" is plural'). With them, negation, you_number and introduced flag no planted error at all. Asked about the translation alone, introduced finds 69% of planted errors (precision 100%), negation 33%, and speaker rises from 61% to 82% (precision 99%). The prompts that name "this translation" or "the translation" (speaker, referent, C1) hold up best.
- **question (M1) cannot be measured with this mutation.** "?" → "." keeps English interrogative word order, so Jev still reads a question. That answer is arguably right.
- **Low-resource forms are where Jev is weakest.** Jev barely tells Tok Pisin "yu" from "yupela" (recall ≤ 17%), or "yumi" from "mipela" (24% on 38 cases).

### Recommended mode per question

| Question | Recommended | Why |
| --- | --- | --- |
| tq (C1) | **active** | Precision 94%, recall 100% at ≥ 0.4. It is an info finding for review that never redrafts, so the 6% false "no" on published text is cheap. Recall is measured only on easy negatives; measure subtle ones before relying on it. |
| speaker (V13) | shadow | 61% recall in production's state. Translation only, it passes the gate (P 99%, R 82%): a candidate for active once its state drops the source and facts, after a re-run. |
| introduced (P11) | shadow | 0% recall in production's state. Translation only: P 100%, R 69%, below the 80% recall gate. |
| referent (P13) | shadow | Precision about 60% in every state. The question names the Greek verb's gloss, which the translation may word otherwise, and it cannot point at the pronoun without a word alignment. |
| negation (M3) | shadow | 0% recall in production's state, 33% translation only. "Is this statement negative?" may also be read as tone. |
| you_number (P8) | shadow | 0% in production's state (Jev answers with the Greek number); ≤ 17% translation only. |
| we_inclusive (P9) | shadow | Too few cases (38 a side) and near chance: P 50%, R 24%. |
| question (M1) | shadow | 0–1% recall, but the mutation keeps the question's word order (see above); it needs a test with declarative rewrites. |

Follow-ups this suggests (not done here; each needs its own eval):

- Leave the source and the facts line out of the state for the questions about the translation's wording, or name "the translation" in every prompt, then re-run.
- Give C1 subtle negatives, for example a name swapped in the passage.

## The run in production's state

- Run: 2026-10-06, model typesafe/jev-1.13, pack 1.2.0, the World English Bible NT (eng-engwebp, public domain).
- Calls: 197 of a cap of 2000; 0 failed outright; 9 s.
- Cost: $0.0299 (as the responses reported it).
- Cases: up to 150 published verses per question and their planted twins (seed 1701); C1: 40 chapters, half of each one's questions with an answer from another book. 12 cells per call, one call per chapter for C1, never a verse beside its planted twin.
- State: as production sends it: each cell's source (the Greek), translation and facts line.

A flag is a "no" at the band's certainty |p − 0.5|·2. Precision: flags on planted errors over all flags. Recall: flags on planted errors over all planted errors (an abstention is a miss). Abstain: answers below certainty 0.4, as production abstains.

| Question | Published | Planted | Abstain | P ≥ 0.4 | R ≥ 0.4 | P ≥ 0.6 | R ≥ 0.6 | P ≥ 0.8 | R ≥ 0.8 | Calls | Tokens in/out | Cost | Recommended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| speaker | 150 | 150 | 17% | 100% | 61% | 100% | 35% | 100% | 1% | 25 | 100816/6150 | $0.0042 | shadow |
| question | 150 | 150 | 5% | n/a | 0% | n/a | 0% | n/a | 0% | 25 | 94076/5550 | $0.0040 | shadow |
| negation | 150 | 150 | 30% | n/a | 0% | n/a | 0% | n/a | 0% | 25 | 90884/5850 | $0.0038 | shadow |
| you_number | 150 | 150 | 0% | n/a | 0% | n/a | 0% | n/a | 0% | 25 | 96070/5850 | $0.0040 | shadow |
| referent | 150 | 150 | 48% | 62% | 60% | 66% | 35% | 86% | 4% | 25 | 97382/6150 | $0.0041 | shadow |
| we_inclusive | 38 | 38 | 25% | 50% | 24% | 50% | 11% | n/a | 0% | 7 | 27430/1636 | $0.0012 | shadow |
| introduced | 150 | 150 | 11% | n/a | 0% | n/a | 0% | n/a | 0% | 25 | 96800/6150 | $0.0041 | shadow |
| tq | 312 | 291 | 9% | 94% | 100% | 97% | 100% | 99% | 100% | 40 | 109158/10618 | $0.0046 | active |

The script's own verdict, by the design doc's gate alone:

- **speaker**: shadow — precision 100%, recall 61% at certainty ≥ 0.4; at certainty ≥ 0.8 precision is 100% (recall 1%), which a per-question threshold could use.
- **question**: shadow — precision n/a, recall 0% at certainty ≥ 0.4.
- **negation**: shadow — precision n/a, recall 0% at certainty ≥ 0.4.
- **you_number**: shadow — precision n/a, recall 0% at certainty ≥ 0.4.
- **referent**: shadow — precision 62%, recall 60% at certainty ≥ 0.4.
- **we_inclusive**: shadow — precision 50%, recall 24% at certainty ≥ 0.4.
- **introduced**: shadow — precision n/a, recall 0% at certainty ≥ 0.4.
- **tq**: active — precision 94% and recall 100% at certainty ≥ 0.4 pass the gate.

## Ablations: what the state does to the answers

The same cases (same seed), asked of the seven per-cell questions with less in the state. C1's state has no source or facts line, so it was not re-run.

Without the facts line (`--no-facts`; 157 calls, $0.0209):

| Question | Published | Planted | Abstain | P ≥ 0.4 | R ≥ 0.4 | P ≥ 0.6 | R ≥ 0.6 | P ≥ 0.8 | R ≥ 0.8 | Calls | Tokens in/out | Cost | Recommended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| speaker | 150 | 150 | 10% | 100% | 84% | 100% | 75% | 100% | 19% | 25 | 81934/6150 | $0.0034 | active |
| question | 150 | 150 | 6% | n/a | 0% | n/a | 0% | n/a | 0% | 25 | 75308/5550 | $0.0032 | shadow |
| negation | 150 | 150 | 60% | 47% | 5% | 38% | 2% | 50% | 1% | 25 | 76130/5850 | $0.0032 | shadow |
| you_number | 150 | 150 | 15% | 73% | 5% | 75% | 2% | n/a | 0% | 25 | 79348/5850 | $0.0033 | shadow |
| referent | 150 | 150 | 32% | 58% | 72% | 64% | 57% | 77% | 16% | 25 | 79520/6150 | $0.0033 | shadow |
| we_inclusive | 38 | 38 | 29% | 50% | 24% | 67% | 5% | n/a | 0% | 7 | 22078/1636 | $0.0009 | shadow |
| introduced | 150 | 150 | 17% | 88% | 5% | 100% | 1% | n/a | 0% | 25 | 83124/6150 | $0.0035 | shadow |

The translation alone, without the source or the facts line (`--no-facts --no-source`; 157 calls, $0.0122):

| Question | Published | Planted | Abstain | P ≥ 0.4 | R ≥ 0.4 | P ≥ 0.6 | R ≥ 0.6 | P ≥ 0.8 | R ≥ 0.8 | Calls | Tokens in/out | Cost | Recommended |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| speaker | 150 | 150 | 10% | 99% | 82% | 100% | 67% | 100% | 28% | 25 | 46972/6150 | $0.0020 | active |
| question | 150 | 150 | 7% | 100% | 1% | 100% | 1% | n/a | 0% | 25 | 44688/5550 | $0.0019 | shadow |
| negation | 150 | 150 | 51% | 75% | 33% | 84% | 21% | 88% | 5% | 25 | 43990/5850 | $0.0018 | shadow |
| you_number | 150 | 150 | 23% | 86% | 17% | 82% | 9% | 100% | 1% | 25 | 46386/5850 | $0.0019 | shadow |
| referent | 150 | 150 | 37% | 60% | 67% | 68% | 52% | 85% | 15% | 25 | 47188/6150 | $0.0020 | shadow |
| we_inclusive | 38 | 38 | 42% | 69% | 24% | 100% | 5% | n/a | 0% | 7 | 12346/1636 | $0.0005 | shadow |
| introduced | 150 | 150 | 16% | 100% | 69% | 100% | 41% | 100% | 2% | 25 | 47792/6150 | $0.0020 | shadow |

What the answers show (from `--dump`):

- **you_number:** in production's state, Jev answers by the Greek number. Plural verses got a confident "no, not one person" whichever form was planted ("yupela" or "yu"); singular verses got "yes". The state's Greek "you" (σύ or ὑμεῖς) and its facts line ('"you" is plural') give the answer away.
- **introduced:** the facts line names the participant ("named: Philip") and the Greek source has the name. With either one in the state, Jev says the participant is identified even after the translation's name became "he".
- **negation:** the mean p(yes) was 0.82 on published text and 0.72 with every negator dropped. Jev answered from the source's negation.

## Adjudication notes

- **C1, false "no" on published text (18 of 312).** Most sampled ones are Translation Questions whose answer goes beyond the words of its verses, for example "unaware that the day of destruction had come" for the days of Noah, or Luke 1:1–2's eyewitnesses who "wrote down an account". A "no" there is defensible; it is not all Jev error.
- **C1's clip** (1000 characters a passage) never cut a passage here: the longest NT Translation Question range in WEB is 606 characters.
- **Planted errors were checked by hand before the run.** That review tightened two generators. A referent error is planted only on the pronoun of the subject's own verb ("He brought"). An introduction case never uses a name in an apposition ("John the Baptizer"). It also stopped production P13 from asking about participants the pack labels with a pronoun's gloss ("anyone", "which").

## How each question was tested

- **speaker** (459 verses qualified): Verses where a speech opens with a named speaker (ACAI person) whose name WEB prints; planted: the name swapped for Peter (John for Peter).
- **question** (795 verses qualified): Verses the Greek marks as a question, WEB with "?"; planted: every "?" made "." (English keeps interrogative word order, so some "yes" answers on planted cases may be defensible).
- **negation** (2204 verses qualified): Verses with a Greek negator and an English one; planted: every English negator dropped ("don’t" → "do", "nothing" → "something").
- **you_number** (2219 verses qualified): Verses whose Greek "you" is all singular or all plural; Tok Pisin "yu"/"yupela" planted for every English "you" (English does not mark the number), then swapped.
- **referent** (207 verses qualified): Verses where the pack finds an implied subject with a same-gender, same-number look-alike, and WEB puts a pronoun right before that verb's gloss ("He brought"); planted: that pronoun made the look-alike's name. The question names the Greek verb's gloss, which WEB may word otherwise.
- **we_inclusive** (38 verses qualified): Verses where the pack decides the clusivity of every "we"; Tok Pisin "yumi" (inclusive) / "mipela" (exclusive) planted for English "we", then swapped.
- **introduced** (664 verses qualified): Verses with a participant's first mention after a pericope boundary, named in the Greek and in WEB, not in an apposition ("John the Baptizer" stays identified without "John"); planted: the name made a pronoun.
- **tq** (260 chapters qualified): Whole chapters, one call each as production asks: of the Translation Questions whose verses WEB has, half keep their answer and half (the planted errors) get the answer of a question from another book.

## Limits

- One published English translation. Low-resource forms come only from planted Tok Pisin pronouns.
- The planted errors are synthetic; C1's negatives are easy.
- One run per configuration besides the repeated production-state run.
- Cost is what the decisions endpoint reported, about $0.00013 a call here. That is four times the design doc's $0.00003 estimate, because these calls carry 12 cells or a whole chapter.

## Reproduce

```
npx tsx scripts/jev-shadow-eval.ts --pack <bible-wiki>/content/bkp/v1 --text <ebible>/corpus/eng-engwebp.txt --vref <ebible>/metadata/vref.txt --max-calls 2000 --samples 150 --tq-chapters 40 --seed 1701
# ablations, the seven per-cell questions:
#   … --no-facts --questions speaker,question,negation,you_number,referent,we_inclusive,introduced
#   … --no-facts --no-source --questions speaker,question,negation,you_number,referent,we_inclusive,introduced
# --dump answers.jsonl writes every answer with its case, for adjudication.
```
