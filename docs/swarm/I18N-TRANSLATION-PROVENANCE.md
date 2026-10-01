# Translation provenance — `th` / `my` / `mfa` / `ar`

**Read this before treating any non-English catalog as reviewed.**

> ## `fr` (French) — AQU-1432, 2026-09-25
>
> Machine-translated by Claude Sonnet agents from the full `pnpm i18n:todo` packet (6,446
> leaves, 5,660 of 5,810 keys written; the rest are formats, product names, cognates and
> placeholder-only strings that `parseTranslatedCatalog` skips as identical to English). **No
> French speaker has read it.** The brief asked for international (not Québécois) French,
> *vous*, infinitive buttons, French typography, and a fixed glossary (cell → cellule, lane →
> piste, changeset → ensemble de modifications, termbase → base terminologique,
> back-translation → rétrotraduction). Mechanical checks: 0 placeholder or tag drift and 0
> missing leaves after merge. Hand fixes: `org.projectOverview.deadlineDatePlaceholder` stays
> English because `DatePicker` only parses the en-US shape (the same trap as
> `common.datePlaceholder`), and ten short labels were tightened to fit their length hints.
> About 170 strings still exceed a soft length hint, mostly long descriptions. A native
> review should check these first: role names (réviseur / responsable de projet / mainteneur),
> the audio voice-tone adjectives, and the milestone gender agreement ("Diapositive précédente").

> ## Correction — the `mfa` catalog was not Patani Malay (AQU-1306)
>
> Everything below about `mfa` describes a catalog that **was standard Malay, not Patani
> Malay**. The Pattani Malay team reported on 2026-09-17 that selecting "Bahasa Melayu
> Patani" produced ordinary Bahasa Malaysia, and an audit of all 4,251 translated values
> confirmed it: **zero** distinctively Patani forms anywhere (no `kawe`, `takdok`, `guano`,
> `mano`, `nok`, `buleh`), against 1,121 values carrying a distinctively standard-Malay form
> whose Patani counterpart differs (`anda` ×361, `tidak` ×345, `tiada` ×208, `boleh` ×138).
>
> The "measurably worked" note below is the tell, not a success: the sweep agent argued about
> what belongs in **"professional Malay technical UI"** and was never reasoning about Patani
> at all. The coverage table's `mfa` row therefore measured fill rate against the wrong
> language — a 98.5% score for content that was 0% Patani Malay.
>
> AQU-1306 moved the catalog to its true code, `ms` / "Bahasa Melayu"
> (`src/lib/i18n/messages/ms.ts`), and retired `mfa` from the switcher; stored `mfa`
> preferences alias to `ms` so nobody loses a working UI. **Patani Malay is now an unshipped
> language**, and it must be authored and signed off by Patani Malay speakers — it is not
> derivable from the `ms` catalog by machine, which is precisely how this shipped.
>
> The lesson generalizes to the rest of this document: an unreviewed catalog can be wrong
> about *which language it is*, not merely about word choice, and none of the mechanical
> checks listed under "Why coverage can never read 100%" can see that.

## What these translations are

Every string added to `src/lib/i18n/messages/{th,my,mfa,ar}.ts` in this pass was produced by
**LLM translation agents (Claude Haiku)**, not by a human speaker of the target language. No
`th`, `my`, `mfa`, or `ar` speaker has read them.

This follows existing precedent in this repo — commits `28618fd3` ("populate th/my/mfa/ar
catalogs"), `858a4df2`, and `55f0b35f` ("translate the wave-4 catalog across four locales")
did the same. It does **not** supersede the standing position in
`docs/swarm/I18N-ORCHESTRATION.md`: Biblica's `my`/`mfa` reviewers and the `th` consultant
remain the real gate, and an unreviewed catalog shipped *as if* reviewed is worse than an
empty one, because the English fallback is honest.

`source-hashes.json` records the English source each key was translated against, so when an
English string later changes, `pnpm i18n:todo` reports the translation as **stale** rather
than silently shipping a translation that now describes something else.

## Coverage after this pass

Two rounds ran: the main pass against a 4,141-key base, then a top-up after wave 2's keying
added 193 more (4,334 total).

| Locale | Keys translated | Of base | Coverage | Left as English |
| --- | ---: | ---: | ---: | ---: |
| `th` Thai | 4,279 | 4,334 | 98.7% | 55 |
| `my` Burmese | 4,282 | 4,334 | 98.8% | 52 |
| `mfa` Patani Malay | 4,267 | 4,334 | 98.5% | 67 |
| `ar` Arabic | 4,282 | 4,334 | 98.8% | 52 |

Baseline before this work was ~93% of a 3,523-key base. The keys still in English are
deliberate — see "Why coverage can never read 100%" below. **Exactly one genuine gap** was
found across all four locales at the end (`org.orgSettings.noSessionError` in `my`, dropped by
an agent) and was filled separately.

The top-up round's brief was rewritten to counter over-conservatism observed in round one, and
it measurably worked: `mfa` went from arguing that "Audio"/"Status"/"Metadata" must stay English
to rendering them as "Suara"/"Keadaan"/"Maklumat".

## How it was produced

1. `pnpm i18n:todo` emitted, per locale, only the untranslated and stale leaves (3,567 total)
   with each one's English source and translator context note.
2. Those were compacted (the namespace `Surface:` paragraph was repeated verbatim on every
   leaf — ~80% of the bytes — so it was hoisted once per namespace) and split into 140-leaf
   chunks.
3. 12 agents translated the chunks against a shared brief; 4 more did a second **sweep pass**
   over leaves returned identical to English, to separate correct restraint from misses.
4. A validator merged the results and **dropped** any leaf whose `{placeholder}` set differed
   from the English before import.
5. `pnpm i18n:import <locale>` (merge, not replace) regenerated each catalog.

## What was verified mechanically

- **Placeholder integrity — 0 drift across all 3,567 leaves.** Any leaf whose placeholders
  did not match English would have been dropped rather than imported (it would render literal
  braces to the user). None had to be.
- **0 missing, 0 hallucinated keys** — every leaf asked for came back, none invented.
- **0 violations of documented `maxLength`** in any locale.
- `src/lib/i18n/messages/placeholders.test.ts` now enforces the placeholder rule permanently,
  on every future import. It was verified non-vacuous by renaming `{language}` to `{langue}`
  in `th.ts` and confirming it fails.
- `pnpm i18n:check` clean (4,141 keys covered); `npm run build` clean.

## What was NOT verified, and needs a human

- **Meaning.** Nothing here checks that a translation says what the English says. Mechanical
  checks cannot catch a fluent, confident mistranslation.
- **Register and terminology consistency** across 4,000 keys, especially the Bible-translation
  domain vocabulary (source/target, cell, draft, staged vs applied).
- **Arabic plural correctness.** Arabic needs six CLDR forms where English writes two; the
  agents reported producing grammatically distinct forms per category (one group of six per
  counted message, ~53 distinct plural groups), but "distinct" is not "correct". The dual
  (`#two`) and `#few`/`#many` distinctions are the most likely place for errors.
- **`mfa` (Patani Malay) is the weakest of the four and should be reviewed first.** Its sweep
  agent returned **zero** additional translations, arguing that "Audio", "Media", "Metadata",
  "Status", "Format", "Model" and "Beta" are established loan words in professional Malay
  technical UI and that translating them would make them *less* recognizable. That argument is
  defensible, but the agent also visibly reversed its own reasoning mid-report, and `mfa` ends
  with more untranslated leaves (71) than any other locale. A Patani Malay speaker should
  confirm or overturn this — it was left standing rather than overridden, because it is a
  language judgment no one on this side of the work is qualified to make.
- **`th` (Thai) first-pass conservatism.** Its first-pass agent left 196 leaves in English,
  far more than the other locales, classifying ordinary UI words ("Scopes", "blocked",
  "tracking", "cloud") as machine-readable codes. The sweep pass recovered 140 of them. If
  another locale is ever added, expect this failure mode and budget for the second pass.

## Why coverage can never read 100%

About 50 keys per locale have an English form that IS the correct translation: file formats
(`USFM`, `XLIFF 1.2`, `PO/POT, Java properties`), product names (`Google Drive`,
`PowerPoint (.pptx)`, `Door43 (DCS)`), domain hints (`helloao.org`, `UBS MARBLE`), and
pure-placeholder templates (`{role} ({level})`, `{pct}% · {loaded} / {total}`,
` ({completed}/{total})`).

`parseTranslatedCatalog` deliberately treats a value equal to its English source as
"not translated" and skips it, so these keys are never written into a locale catalog and
**`pnpm i18n:todo` will list them again on every future run**. That is correct behaviour, not
a bug or an incomplete pass: the alternative is writing a redundant copy of the English into
four catalogs, which buys nothing and makes real drift harder to spot.

Practical consequence: **do not chase 100%.** The only way to reach it is to "translate" keys
that must not be translated. A locale sitting at ~98-99% with a stable ~50-key remainder of
formats and product names is the finished state.

## Re-running this

`pnpm i18n:todo` regenerates the delta at any time — it reports untranslated *and* stale
leaves, so after English copy changes it will surface exactly what drifted. The chunking,
validation and sweep scripts used here were orchestration-side and are not committed; the
durable pieces are `scripts/i18n-todo.ts`, `scripts/i18n-catalog.ts`, and the placeholder test.
