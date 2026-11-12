# Translation provenance — `th` / `my` / `mfa` / `ar`

**Read this before treating any non-English catalog as reviewed.**

> ## Combined branch, 2026-10-28
>
> `ha`, `ur`, `bn`, `am`, and `pa` were translated against an older `dev`.
> Twelve keys that English no longer has were removed from each catalog and
> from `source-hashes.json` when those catalogs were combined onto current
> `dev`: `editor.timeline.bladeFreeTiming`, the five `audio.characters.filter*`
> age filters, `org.overviewLaneTable.pctTextValidated`,
> `org.overviewLaneTable.pctAudioValidated`, the three
> `workspace.timingVideoWarning.*` strings, and `transcribe.status.failed`.
> The import counts in the notes below are the original importer reports.

> ## `ha` (standard written Hausa) — AQU-2199, 2026-10-27
>
> Unreviewed machine draft. Machine-translated from the full `pnpm i18n:todo` packet
> (9,565 leaves) and merged with `scripts/i18n-catalog.ts import`. **No Hausa speaker
> has read it.** Variety: standard written Hausa, the Kano-based standard of education
> and BBC Hausa, in Latin Boko (including ɓ ɗ ƙ). Not Ajami, not a city dialect, not
> Ghanaian Hausa, not Nigerian Pidgin. Buttons use the polite plural imperative (`ku`).
> `ha-NG`, `ha-NE`, and `ha-Latn` fold onto `ha`. Ajami (`ha-Arab`) is not registered.
>
> Glossary: cell → ƙwaya / ƙwayoyi, lane → hanya / hanyoyi, changeset → rukunin
> canje-canje, termbase → ma'ajiyar kalmomi, back-translation → fassarar komawa,
> source → asali, target → manufa, draft → daftari / daftarori. Also locked in this
> draft: Recently deleted → An goge kwanan nan, corpus → kundi, validate → tabbatar
> (approve stays amince), Apply → Ku aiwatar, outbox → Akwatin fita, knowledge base →
> Tushen ilimi. Timeline audio and caption tracks use waƙa / waƙoƙi; hanya stays the
> language lane. Plurals: `one` is only for 1, and 0 uses `other`.
>
> Import report: 8,902/9,039 keys. The leaves the importer dropped were identical to
> English on purpose (formats, product names, placeholder-only templates, and the
> keep-English labels below). Mechanical check before import: every todo leaf present,
> no extra leaf, and no added `{placeholder}`. Plural leaves may drop `{count}` and
> must not add a placeholder the English seed does not have. `common.datePlaceholder`
> stays `June 01, 2025`. `org.projectOverview.deadlineDatePlaceholder` stays
> `July 03, 2026`. Whole values that are exactly Source text, Source audio, Target
> text, Target audio, Speaker, Camera, Character Label, or Cast stay English, and
> those tokens stay English inside a sentence that names the product label. Role names
> inside `org.membersPage.orgTable.projectAccessNote` stay Contributor, Project lead,
> Viewer, Maintainer, and Owner. Every `knowledgeBase.*` value differs from English.

> ## `ur` (Modern Standard Urdu) — AQU-2200, 2026-10-27
>
> Unreviewed machine draft. Machine-translated from the full `pnpm i18n:todo` packet
> and merged with `scripts/i18n-catalog.ts import`. **No Urdu speaker has read it.**
> The variety is Modern Standard Urdu (معیاری اردو): formal آپ, Perso-Arabic script,
> polite imperative buttons, RTL. It was not derived from the Hindi catalog.
> Glossary: cell → خانہ, lane → لین, changeset → مجموعۂ تبدیلی, termbase →
> اصطلاحی ذخیرہ, back-translation → معکوس ترجمہ, source → ماخذ, target → ہدف,
> draft → مسودہ.
>
> Plurals: `Intl.PluralRules("ur")` has `one` and `other`. `one` is only for 1;
> 0 uses `other`. Identical wording on both forms is grammatical when the noun
> does not change.
>
> Import report: 8,895/9,039 keys. The leaves the importer dropped were identical
> to English on purpose (formats, product names, placeholder-only templates, and
> the keep-English labels). Mechanical check before import: every todo leaf
> present, no extra leaf, and no added `{placeholder}`. Non-plural leaves kept
> the exact placeholder set. Plural leaves could drop `{count}` and did not add
> any placeholder the English seed lacked. `common.datePlaceholder` stays
> `June 01, 2025`. `org.projectOverview.deadlineDatePlaceholder` stays
> `July 03, 2026`. Source text, Source audio, Target text, Target audio, Speaker,
> Camera, Character Label, and Cast stay English when they are the product label.
> Inside `org.membersPage.orgTable.projectAccessNote`, Contributor, Project lead,
> Viewer, Maintainer, and Owner stay English.

> ## `bn` (Bangladeshi Bengali) — AQU-2201, 2026-10-26
>
> Machine-translated from the full `pnpm i18n:todo` packet (9,565 leaves) and merged
> with `scripts/i18n-catalog.ts import`. **No Bengali speaker has read it.** This is an
> unreviewed machine draft. The menu endonym stays বাংলা. The wording is Bangladeshi
> standard colloquial Bengali (প্রমিত চলিত বাংলা): আপনি imperative, পানি not জল. Not
> sadhu bhasha, and not a regional dialect. `bn-BD` and `bn-IN` fold onto `bn`.
> Glossary: cell → সেল, lane → লেন, changeset → পরিবর্তনসেট, termbase →
> পরিভাষাভাণ্ডার, back-translation → বিপরীত অনুবাদ, source → উৎস, target → লক্ষ্য,
> draft → খসড়া.
>
> Bengali plurals are `one` and `other`. `one` covers 0 and 1. The two forms may share
> wording when the noun does not change.
>
> Import report: 8,931/9,039 keys. The leaves the importer dropped were identical to
> English on purpose (formats, product names, placeholder-only templates, and the
> track labels that stay English). Mechanical check before import: 0 missing leaves
> and no added `{placeholder}`s. Plural leaves may drop `{count}` and must not add a
> placeholder the English seed does not have; this pass added none.
> `common.datePlaceholder` stays `June 01, 2025` and
> `org.projectOverview.deadlineDatePlaceholder` stays `July 03, 2026` because the
> date parser only accepts those en-US shapes. Source text, Source audio, Target
> text, Target audio, Speaker, Camera, Character Label, and Cast stay English when
> they name the product label, including "Target audio" and "Source text" inside
> longer sentences. Role names inside `org.membersPage.orgTable.projectAccessNote`
> stay English: Contributor, Project lead, Viewer, Maintainer, and Owner.

> ## `am` (standard written Amharic) — AQU-2203, 2026-10-27
>
> Unreviewed machine draft. Machine-translated from the full `pnpm i18n:todo` packet
> (9,565 leaves) and merged with `scripts/i18n-catalog.ts import`. **No Amharic speaker
> has read it.** Variety: Addis Ababa written standard, Geʽez script, LTR, formal
> imperative; not Tigrinya. `am-ET` folds onto `am`. Plural category `one` covers 0 and 1.
>
> Glossary: cell → ሕዋስ, lane → መስመር, changeset → የለውጥ ስብስብ, termbase → የቃላት መዝገብ,
> back-translation → የተገላቢጦሽ ትርጉም, source → ምንጭ, target → ዒላማ, draft → ረቂቅ.
>
> Import report: 8,917/9,039 keys. Identical-to-English leaves were dropped on purpose
> (formats, product names, and placeholder-only templates). Placeholder check before
> import found no added placeholders. `common.datePlaceholder` stays `June 01, 2025`.
> `org.projectOverview.deadlineDatePlaceholder` stays `July 03, 2026`. Track labels and
> Speaker / Camera / Character Label / Cast stay English. Role names inside
> `org.membersPage.orgTable.projectAccessNote` stay Contributor, Project lead, Viewer,
> Maintainer, and Owner.

> ## `pa` (Gurmukhi Punjabi, Majhi) — 2026-10-27
>
> Unreviewed machine draft. Machine-translated from the full `pnpm i18n:todo`
> packet and merged with `scripts/i18n-catalog.ts import` (AQU-2202). **No
> Punjabi speaker has read it.** Not derived from Hindi or Urdu. Not Shahmukhi.
> The variety is Indian standard Punjabi, Gurmukhi, Majhi, LTR. Buttons use
> ਤੁਸੀਂ and the polite imperative. Bare `pa` is Gurmukhi, so `pa-IN` folding
> onto `pa` is right. `pa-Arab` and `pa-PK` currently fold onto this Gurmukhi
> catalog by primary subtag, which is the wrong script for a Shahmukhi reader;
> Shahmukhi needs its own future locale. `normalizeLocale` was not changed.
> Plurals follow `Intl.PluralRules("pa")`: `one` and `other`, and `one` covers
> 0 and 1. Identical wording on both forms is grammatical when the noun does
> not change.
>
> Glossary: cell → ਸੈੱਲ, lane → ਲੇਨ, changeset → ਬਦਲਾਅ-ਸਮੂਹ, termbase →
> ਸ਼ਬਦ-ਅਧਾਰ, back-translation → ਉਲਟਾ-ਅਨੁਵਾਦ, source → ਸਰੋਤ, target → ਟੀਚਾ,
> draft → ਖਰੜਾ.
>
> Import report: 8,909/9,039 keys. Identical-to-English leaves were dropped on
> purpose (formats, product names, placeholder-only templates, and locked
> English labels). Mechanical check before import found no added placeholders:
> non-plural leaves kept the exact placeholder set, and plural leaves could
> drop `{count}` only. `common.datePlaceholder` stays `June 01, 2025`.
> `org.projectOverview.deadlineDatePlaceholder` stays `July 03, 2026`.
> Whole-string labels Source text, Source audio, Target text, Target audio,
> Speaker, Camera, Character Label, and Cast stay English, including those
> tokens inside longer sentences when they name the product label.
> `org.membersPage.orgTable.projectAccessNote` keeps Contributor, Project lead,
> Viewer, Maintainer, and Owner in English.

> ## `sw` (Kiswahili sanifu) — AQU-2198, 2026-10-26
>
> Machine-translated from the full `pnpm i18n:todo` packet (9,565 leaves) and merged
> with `scripts/i18n-catalog.ts import`. **No Swahili speaker has read it.** One
> catalog, worded as Kiswahili sanifu — the written East African standard, not a
> Kenyan or Tanzanian national dialect, not Sheng, and not Congolese Swahili
> (Kingwana). The menu endonym stays Kiswahili. `sw-KE` and `sw-TZ` fold onto `sw`;
> `swc` does not. Buttons use the imperative (Hifadhi, Ghairi, Futa). Glossary:
> cell → seli, lane → njia, changeset → seti ya mabadiliko, termbase → hazina ya
> istilahi, back-translation → tafsiri ya nyuma, source → chanzo, target → lengo,
> draft → rasimu, project → mradi, organization → shirika.
>
> Import report: 8,912/9,039 keys. The leaves the importer dropped were identical to
> English (formats, product names, placeholder-only templates, and the labels that
> must stay English). Mechanical check before import: 9,565 leaves, 0 missing, and
> 0 `{placeholder}` drift. Plural forms may omit `{count}` and add none.
> `common.datePlaceholder` stays `June 01, 2025` and
> `org.projectOverview.deadlineDatePlaceholder` stays `July 03, 2026` because the
> date parser only accepts that en-US shape. The track labels Source text, Source
> audio, Target text, and Target audio stay English, as do Speaker, Camera, and the
> quoted column names Character Label, Cast, and Speaker. Role names inside
> `org.membersPage.orgTable.projectAccessNote` stay English (Contributor, Project
> lead, Viewer, Maintainer, Owner) so they match the role picker.

> ## `hi` (Hindi) — 2026-10-23
>
> Machine-translated from the full `pnpm i18n:todo` packet (9,190 leaves) and merged
> with `scripts/i18n-catalog.ts import`. **No Hindi speaker has read it.** The menu
> endonym is हिन्दी; the wording uses आप and the polite imperative for buttons
> (सहेजें, रद्द करें). Glossary: cell → कक्ष, lane → लेन, changeset →
> परिवर्तन-समूह, termbase → शब्दावली आधार, back-translation → प्रतिअनुवाद,
> source → स्रोत, target → लक्ष्य, draft → मसौदा. Hindi plurals are one and other
> only (`one` covers 0 and 1). Identical wording on both forms is correct when the
> noun does not change, as with कक्ष.
>
> Import report: 8,575/8,682 keys. The leaves the importer dropped were identical to
> English (formats, product names, placeholder-only templates, and labels the UI
> still draws in English, such as Source text, Source audio, Speaker, and Camera).
> Mechanical check before import: 0 missing leaves and 0 `{placeholder}` drift.
> `common.datePlaceholder` stays `June 01, 2025` because the date parser only
> accepts that en-US shape. The Monday "make a new board" strings were already in
> this packet and are included. Role names inside
> `org.membersPage.orgTable.projectAccessNote` stay English because that sentence
> is matched against the hardcoded English role labels.
>
> Merging `dev` on 2026-10-27 dropped 29 keys `dev` had retired since the draft
> (`projectSettings.languages.*` lane settings, `terminology.libraryStats.*`,
> `workspace.castGutterVoice.*` and five others), leaving 8,546 keys. The ~500
> strings `dev` added after the draft still read in English until the next
> `pnpm i18n:todo` pass.

> ## `es` (Latin American Spanish) — 2026-10-20
>
> Machine-translated from the full `pnpm i18n:todo` packet (9,682 leaves) and merged
> with `scripts/i18n-catalog.ts import`. **No Spanish speaker has read it.** The menu
> endonym stays Español; the wording is neutral Latin American (tú, ustedes, no
> vosotros, no voseo, archivo, computadora, infinitive buttons). Glossary: cell →
> celda, lane → carril, changeset → conjunto de cambios, termbase → base
> terminológica, back-translation → retrotraducción, source → origen, target →
> destino, draft → borrador.
>
> Import report: 8,528/8,682 keys. The leaves the importer dropped were identical to
> English (formats, product names, and placeholder-only templates). Mechanical check
> before import: 0 missing leaves and 0 `{placeholder}` drift. `common.datePlaceholder`
> stays `June 01, 2025` because the date parser only accepts that en-US shape. Strings
> added on `dev` after the draft — the Monday "make a new board" step — were translated
> in the same variety and merged on top.

> ## `pt` (Brazilian Portuguese) — 2026-10-20
>
> Machine-translated from the full `pnpm i18n:todo` packet (9,682 leaves) and merged
> with `scripts/i18n-catalog.ts import`. **No Portuguese speaker has read it.** The
> menu endonym stays Português; the wording is Brazilian (você, arquivo, salvar, tela,
> usuário, baixar, infinitive buttons). Glossary: cell → célula, lane → faixa,
> changeset → conjunto de alterações, termbase → base terminológica, back-translation
> → retrotradução, source → origem, target → destino, draft → rascunho.
>
> Import report: 8,533/8,682 keys. The leaves the importer dropped were identical to
> English (formats, product names, and placeholder-only templates). Mechanical check
> before import: 0 missing leaves and 0 `{placeholder}` drift. `common.datePlaceholder`
> stays `June 01, 2025` because the date parser only accepts that en-US shape. Strings
> added on `dev` after the draft — the Monday "make a new board" step — were translated
> in the same variety and merged on top.

> ## All locales topped up from `pnpm i18n:todo` — 2026-10-03
>
> The 14,590 untranslated or stale leaves in `th`, `my`, `ms`, `id`, `ar`, `zh-Hans`,
> `zh-Hant`, `ru` and `fr` were machine-translated by Claude Sonnet agents (65 chunks of up
> to 250 leaves, each with the translator note from the context sidecar) and merged with
> `scripts/i18n-catalog.ts import`. **No native speaker has read any of it.** Mechanical
> checks: 0 missing leaves and 0 `{placeholder}`/tag drift after merge (Arabic and Russian
> plural forms may drop `{count}`, e.g. the dual). About 670 leaves still show in
> `i18n:todo` because the agents returned them identical to English (names, cognates,
> formats); the importer skips those by design. `ms` is standard Bahasa Melayu, not Patani
> Malay. `my`, `ms` and `ar` still need their reviewers before this is treated as shipped
> quality.

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
