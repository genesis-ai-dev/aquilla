# SDBH Dictionary Importer — Design Spec

**Date:** 2026-06-17
**Status:** Draft for review
**Author:** Ryder Wishart / Matthew (Frontier R&D), with Claude
**Requestor:** Reinier de Blois (editor, Semantic Dictionary of Biblical Hebrew; United Bible Societies)

## 1. Background & goal

Reinier de Blois edits the **Semantic Dictionary of Biblical Hebrew (SDBH)**. The
dictionary is >99% complete and has been localized into ~16 languages, but
localization is ongoing and unfunded: some target-language definitions and
glosses are missing or out of date. He asked whether Aquilla can:

1. read the dictionary files (XML),
2. store all existing localizations as **translation memory**, and
3. **supply the missing definitions** with AI.

**Delivery decision:** Rather than a one-time batch script, we build this as a
**specialized importer in Aquilla** so that Reinier's team can self-serve: import
the source content once, import an existing localization as the target, let
Aquilla's normal AI-draft + human-vetting workflow fill the gaps, and repeat for
each of the remaining languages **without us holding their hands**. This also
showcases Aquilla to exactly the UBS/SIL cohort that is credibility-critical for
us (the Paratext-native cohort).

Target languages: French, Spanish, Portuguese, Russian, Arabic, Chinese,
Swahili, Indonesian, Hindi, Gujarati, Malayalam, Tamil, Telugu, Mizo, Ao Naga,
Kannada. **Spanish is the pilot.**

## 2. The source data (from the supplied files)

Two files were supplied for Spanish:

- `SDBH-es.zip` → `SDBH-es.XML` (62 MB) — the full **Spanish** localization.
- `SDBH-update-en-es.CSV` — a 1,261-row gap list (English source + mostly-empty
  Spanish target, with a per-field `Remark(s)` column).

Measured facts about the XML:

- **7,932 lemmas** (`Lexicon_Entry`), **16,934 senses** (`LEXMeaning`),
  **15,860 Spanish senses** (`LEXSense LanguageCode="es"`), of which 15,696 are
  filled and ~164 empty.
- Hierarchy with stable IDs at every level:
  `Lexicon_Entry[@Id,@Lemma,@AlphaPos]` → `BaseForm[@Id]` →
  `LEXMeaning[@Id]` → `LEXSense[@LanguageCode]` →
  `{DefinitionLong, DefinitionShort, Glosses>Gloss*, Comments}`.
- **23 alpha-buckets** via `@AlphaPos` (note: `שׁ`/`שׂ` are distinct; `ו` has only
  10 senses). Largest bucket `מ` = 1,796 senses / 948 lemmas.
- There is also a second layer — **23,809 `ContextualMeaning` (CON) nodes**.
  In the supplied Spanish file these are almost entirely **structural** (Hebrew
  collocations, syntactic forms like `verb qal`, scripture references, domain
  codes): only **3 of 23,809** contain a `CONSense` element at all, and all 3 are
  empty. The localizable free-text (definitions + glosses) lives in the **LEX**
  layer, which the gap list targets. The CON `CONDomain` **labels** are localized
  ("Vida y muerte") but belong to a finite shared **domain taxonomy**, not
  per-entry text. See §13/§14: whether CON senses are meant to carry per-language
  glosses (a ~23.8k-node frontier) or are language-neutral by design is an open
  question for Reinier; the architecture accommodates CON localization either way.
- **Critical:** the supplied XML is **Spanish-only — it contains no English.**

Gap-list shape (1,261 rows): 948 have an English source definition but no Spanish
target; 785 are `no localization data found`; the rest are partial
(`no target glosses`, `no target comment`, `no date/time for target definition`).
The remarks are **per-field**, which drives the granularity decision below.

### SDBH notation (must be preserved)

Definitions use a controlled notation that must survive translation:
`=` (definiens), `◄` (presupposition/source), `►` (implication/result),
`≈` (connotation), and lexical cross-references of the form
`{L:Korah<SDBH:קֹרַח>}`. In cross-references, the **display name is translated**
(`Korah`→`Cora`) while the **`<SDBH:…>` lemma pointer is fixed**. Two recognizable
classes need special handling:

- **`see …` senses** (e.g. `אֲבִי` → "see אְַבִי הָעֶזְרִי", `אור` → "see {L:אֹור}")
  are pointers, not prose definitions. Tag as `xref`; do **not** feed to the AI as
  prose to translate.
- **Proper-name entries** (Ebiasaph, Uri, Uriel) — the gloss is the name's
  localized form; the definition is a genealogy formula full of `{L:…}` refs.
  Flag as a class so transliteration conventions (drawn from the existing TM)
  apply.

## 3. How Aquilla represents content (grounding)

- A **cell** is an atomic translatable unit stored as two rows keyed by
  `(project_id, file_id, cell_id, side)` with `side ∈ {source, target}`; content
  is `value` (+ optional `value_html`). Metadata of interest: `type`,
  `canonical_ref`, `anchor_cell_id` (order spine), `ai_drafted`, `validated`,
  `cell_validators`. (`db/postgres/schema.sql` cells table; `src/hooks/useCells.ts`.)
- **Import** parses a file into `TranslatableString[]`, then emits a `file.create`
  event + one `source.cell.create` per cell, chained by `anchor_cell_id`, streamed
  to the sync-worker `POST /import` bulk endpoint. (`src/lib/import.ts`,
  `src/lib/sync/bulk-import.ts`, `sync-worker/src/events/import-route.ts`.)
- **Import-as-target** already exists (eBible/Paratext): match a second source
  onto existing source cells and emit `target.cell.commit`s.
  (`applyEBibleTargetImport`, `importParatextAsTarget` in `src/lib/import.ts`.)
- **Navigation/progress** is not driven by milestone cells. Books are **separate
  files**; chapter/verse is encoded in `canonical_ref` (`"GEN 1:1"`); the section
  navigator groups cells by the `canonical_ref` **prefix before the colon**
  (`"GEN 1"`) with per-section progress + click-to-jump.
  (`src/lib/progress/section-index.ts`, `src/components/sidebar/FileSectionGrid.tsx`.)
- `type: "milestone"` cells are non-translatable structural markers with no nav
  role — **not** the mechanism we want.
- **Round-trip fidelity:** importers may store the raw source on `file.create`
  (`file_source_blobs`), as USFM does today.
- codex-editor already has the **Specialized importers** tier and an
  `ImporterPlugin` registry to mirror.
  (`~/frontierrnd/codex-editor/webviews/codex-webviews/src/NewSourceUploader/`.)

## 4. Architecture (chosen: two importers, source + target-by-id)

**Approach 1** of the three considered (rejected: a single paired importer that
re-imports English per language; a CSV-only importer that discards the TM and the
full dictionary).

Two Specialized importers, mirroring the existing eBible source / eBible-as-target
split:

1. **"SDBH source" importer** — ingests the **English master SDBH XML** → source
   cells. Run once; the resulting source can seed every language project.
2. **"SDBH localization (as target)" importer** — ingests a **language XML**
   (Spanish first) → target cells, **matched onto source cells by the SDBH id**.
   Existing localizations land as pre-filled target cells (the translation
   memory); gaps stay empty for AI-draft + vetting.

**One Aquilla project per target language**, all sharing the same English source
import. ("Move on to the other projects" = a new project per language.)

## 5. Structure & navigation (mirrors scripture)

```
Scripture                       SDBH dictionary
─────────                       ───────────────
File   = Book      (GEN)     →  File    = first letter   (א — from @AlphaPos; 23 files)
Section= Chapter   (GEN 1)   →  Section = headword/lemma  (אֵב; via canonical_ref)
Cell   = Verse     (GEN 1:1) →  Cell    = sense field     (אֵב sense 1 · definition / · glosses)
```

- **23 files, one per `@AlphaPos`.** A translator can "take aleph" and see
  per-letter progress exactly like per-book progress. Largest file (`מ`) is
  ~1,796 senses → ~3.5–4k cells with field-level granularity; comparable to a
  large book and within bulk-import/pagination limits. (If a single letter-file
  ever proves too heavy in practice we can split it; do not pre-optimize.)
- **`canonical_ref` = the lemma** (e.g. `אֵב`) so the section navigator
  auto-groups senses under their headword with click-to-jump + per-headword
  progress, with zero new navigation UI.
- Optional **per-lemma divider cell** (source-only `paratext`/`heading` showing
  `אֵב · ʾēb · noun m`) so the body reads like a dictionary and senses are visually
  grouped under their headword. Not translated.

## 6. Cell granularity (chosen: field-level, grouped per sense)

Each **sense** yields separate cells per translatable field:

- **definition cell** — `DefinitionShort` (and `DefinitionLong` when present).
- **glosses cell** — `Glosses>Gloss*` joined as a `; `-separated list.
- **comment cell** — `Comments`, emitted **only when a source comment exists**.

Rationale: Reinier's gap list is already per-field (`no target definition` vs
`no target glosses` vs `no target comment`), partial gaps are common (definition
present, gloss missing, and vice versa), and the three fields are different kinds
of text (structured prose vs word-list vs note). Field-level cells make each gap a
crisp, independently AI-draftable / vettable / validatable worklist item that maps
1:1 to the gap list, and they round-trip cleanly to their exact XML node.

To preserve the definition↔gloss relationship: keep a sense's cells **adjacent**
(shared anchor + order) and give each source cell a compact self-describing header
(`אֵב · ʾēb · definition` / `· glosses`) so the translator always sees sibling
context.

## 7. Identity & matching scheme

- **`cell_id` is deterministic from the SDBH `LEXMeaning Id` + field**, e.g.
  `lex-000001001001000-def`, `-gloss`, `-comment`. This deterministic id is the
  spine for both target-language matching and round-trip write-back — no fuzzy
  lemma/definition matching.
- `canonical_ref` is reserved for the human-facing nav label (the lemma);
  identity lives in `cell_id`.
- The **target importer matches a language XML's senses to existing source cells
  by this deterministic id**, then emits `target.cell.commit` for each
  non-empty localized field. Empty/missing fields are simply left as gaps.

**Dependency:** the source importer needs the **English master SDBH XML** (or an
English export carrying `LEXMeaning Id`). The supplied XML is Spanish-only. This is
the one thing to request from Reinier before building the source side. He has it;
he already offered to generate exports in other formats.

## 8. Translation memory + gap-fill workflow

- **Translation memory = the existing localizations imported as target cells.**
  Pre-filled target cells (optionally marked `validated`, since they are
  editor-approved published content) give the AI in-domain, in-style exemplars.
- **Gap-fill** uses Aquilla's existing AI-draft path: AI produces a target draft
  (`ai_drafted=1`), grounded by the English source + nearby existing TM pairs in
  the same semantic domain; Reinier's team opens the cell, edits/approves
  (clears `ai_drafted`), and validates. No new translation engine.
- The AI prompt must **preserve SDBH notation** (`= ◄ ► ≈`), **translate
  `{L:…}` display names while keeping the lemma pointer fixed**, and treat `xref`
  and proper-name cells per their class. Glosses are prompted as short lexical
  equivalents, definitions as structured prose.

## 9. Round-trip export to SDBH XML (Phase 2)

Export-back is essential to the deliverable but **not required in the first
build**. Fidelity is preserved from day one by storing the **raw source XML blob**
on import (`file_source_blobs`), so no information is lost. Phase 2 reconstructs
the language XML by walking the stored source tree and writing each filled/edited
target cell back into its node by deterministic id:
definition cell → `DefinitionShort`, glosses cell → `Glosses` (split on `; `),
comment cell → `Comments`; stamp `LastEditedBy`/`LastEdited` to mark AI/edited
provenance. Output validates against the SDBH schema before hand-off.

## 10. Components (what gets built)

Client (`codex-web-app`):

- `src/lib/parsers/sdbh.ts` — XML parser: stream `Lexicon_Entry` → per-letter
  file grouping → per-sense field cells; classify `xref` / proper-name; emit the
  deterministic ids, anchors, lemma `canonical_ref`, and optional divider cells.
- `src/lib/import.ts` — `importSdbhSource(...)` and `importSdbhLocalizationAsTarget(...)`
  following the eBible source / eBible-as-target patterns.
- `src/components/` — a Specialized-importer panel (mirroring
  `SpreadsheetImportPanel` / the eBible target-review panel), wired into
  `ImportDialog`'s screen state machine under a Specialized/Advanced grouping.
- Reuse existing bulk upload (`src/lib/sync/bulk-import.ts`) and target-commit
  paths unchanged.

Server (`sync-worker`): no new endpoints expected — reuse `POST /import` and the
target-commit projection. Confirm the raw-source-blob path accepts the SDBH XML.

Phase 2: `src/lib/export/sdbh.ts` — reconstruct language XML from cells + stored
source blob.

## 11. Error handling & edge cases

- **Missing/!= English master:** the source importer must detect a Spanish-only
  (or wrong-language) XML and refuse with a clear message rather than importing
  target-language text as source.
- **Id collisions / unknown ids on target import:** report counts of matched /
  unmatched / conflicting (existing non-empty target) cells, like the eBible
  target review panel; never silently overwrite human-edited target content.
- **`xref` and empty-source senses:** skip AI; keep as navigable cells so the
  structure is complete.
- **Notation corruption:** validate on export that `{L:…<SDBH:…>}` pointers and
  `= ◄ ► ≈` structure are intact; flag cells whose target dropped a pointer.
- **Large letter-files:** chunked bulk import (existing 1,500-cell chunks);
  verify pagination over the largest file (`מ`).

## 12. Testing

- **Parser unit tests** (intent-encoding): a fixture of representative entries —
  multi-sense lemma, `see` xref, proper-name genealogy with `{L:…}` refs, a
  comment-bearing sense, an empty sense — asserting correct file bucketing,
  deterministic ids, field-cell split, classification, and notation preservation.
- **Round-trip test (Phase 2):** import English master → import Spanish → export →
  diff against the original Spanish XML; filled cells must reproduce their source
  node exactly (ignoring intended `LastEdited` stamps).
- **Matching test:** target import against a source import resolves by id with zero
  fuzzy matches; unmatched/conflict counts are surfaced.
- **UI walkthrough:** drive the real importer in the dev stack for the Spanish
  pilot — import, see per-letter files + per-lemma sections + gap cells, AI-draft a
  gap, vet it. (Per workspace QA conventions.)

## 13. Scope / phasing

- **Phase 1 (this spec):** source importer + localization-as-target importer +
  structure/nav + field-level cells + AI-draft/vetting on the existing workflow.
  Pilot: Spanish.
- **Phase 2:** round-trip export to SDBH XML; schema validation; provenance stamps.
- **CON layer (pending Reinier):** if he confirms contextual senses should carry
  per-language glosses, add them as `con-<Id>-gloss` field-cells under their lemma
  (no structural change; ~23.8k additional potential cells). If CON is
  language-neutral, the only CON localization is the **domain taxonomy** — a small,
  bounded controlled-vocabulary list localized once per language (worth a tiny
  separate importer/screen if any target language is missing labels).
- **Later:** the other 15 languages (mechanically a repeat of Phase 1 per language
  once the English source is imported).

## 14. Open dependencies / questions for Reinier

1. **English master SDBH XML** (or an English export carrying `LEXMeaning Id`) —
   required for the source importer.
2. Confirm the `LEXMeaning Id` is **stable across language exports** (so target
   matching and round-trip are exact).
3. Confirm desired provenance marking for AI/edited entries on export
   (`LastEditedBy` value, dates).
4. **Contextual senses:** should `ContextualMeaning` (CON) senses carry
   per-language glosses/definitions (in this Spanish file 3/23,809 have a
   `CONSense` and all are empty), or is the CON layer language-neutral structure
   with only the domain taxonomy localized? This roughly doubles scope if the
   former, so it gates Phase planning.
