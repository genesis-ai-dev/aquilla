# QA TEST PLAN — Matecat Parity Run

Written for a **human QA tester**. You need: the app running locally
(`pnpm dev`), a terminal in the repo root, and the test files named below.
**Use DEV-corpus files only** — they live under `parity/corpus/files/…` and
the allowed (dev) file names are listed in `parity/corpus/split.json` under
`"dev"`. Never open files listed under `"holdout"`.

Quick health check before manual testing (all should pass/print 100%):

```bash
pnpm test                 # 3,385 pre-existing tests
pnpm parity:score         # 51 matrix rows + 5 EXCEEDS guards
pnpm roundtrip:score      # dev corpus, per-format rates
```

---

## 1. File import/export round trips

**Risk rating: MEDIUM.** The exporters are new; the most likely breakage is a
format edge (exotic quoting, mixed encodings) not represented in the corpus.
The docx/pptx path additionally depends on the ≤512 KB side-car (see §1.4).

### 1.1 XLIFF (highest commercial importance)
1. In a project, import `parity/corpus/files/xliff12/xliff12-002.xlf` (any dev
   xliff12 file works).
2. Expect one segment per `trans-unit`; pre-translated units show their
   target text; notes appear as segment context.
3. Translate 2–3 segments, validate one.
4. Export as XLIFF (`.xlf`).
5. Verify: `xmllint --noout --schema parity/schemas/xliff-core-1.2-transitional.xsd <exported.xlf>`
   prints "validates".
6. Open the exported file in a text editor: the unit you validated must carry
   `state="final"`, translated-but-unvalidated `state="translated"`, untouched
   `state="new"`; inline `<g>/<x>/<bpt>` tags from the source must still be
   present in `<source>` (not stripped).
7. Repeat with a dev `xliff20/*.xlf` file and
   `parity/schemas/xliff_core_2.0.xsd`.
- **Expected failure to watch for:** segments with inline tags exporting with
  tags dropped from `<source>` — that is a regression of the skeleton path.

### 1.2 TMX
1. Import a dev `tmx/*.tmx` file; expect one segment per `<tu>`, with target
   text populated.
2. Export as TMX; verify with
   `xmllint --noout --dtdvalid parity/schemas/tmx14.dtd <exported.tmx>`.
3. In the exported file, `<bpt>/<ept>/<ph>` tags must survive for unedited
   pairs. (The strip-tags variant is API-level: `exportTmxStructured(cells,
   src, tgt, { keepTags: false })`.)

### 1.3 Text family (txt, md, csv, tsv, srt, vtt)
1. Import a dev `txt/*.txt` with several blank-line-separated paragraphs.
2. Export as `.txt`: paragraph count and blank-line structure must match the
   original; untranslated paragraphs keep source text.
3. Import a dev `md/*.md`; export `.md`: headings keep their `#` level,
   **ordered lists stay `1.`-numbered** (not degraded to `-`), quotes keep
   `>`.
4. Import a dev `srt/*.srt`; export `.srt`: cue count and every timecode
   byte-identical (millisecond precision); cue numbering sequential.
5. Import a dev `vtt/*.vtt` that contains `<v Name>` voice tags; export:
   voice tags and timecodes preserved.
6. CSV/TSV: import a dev `csv/*.csv` with quoted fields/embedded commas;
   export and re-import; values identical.
- **Risk:** CRLF-only files — a fixed bug; re-test on a file saved with
  Windows line endings.

### 1.4 DOCX / PPTX (original-format round trip)
1. Import a small `.docx` (<512 KB, e.g. dev `docx/*.docx`).
2. Translate a couple of paragraphs; Export → DOCX.
3. Open the exported file in Word/LibreOffice: document must open cleanly,
   heading styles intact, translated paragraphs replaced, untranslated ones
   showing source.
4. If any source paragraph mixed bold/plain runs, the export dialog must show
   an amber "segments lost inline formatting" warning naming that paragraph.
5. PPTX: exporter exists at API level (`exportPptx`); the export dialog does
   not yet offer PPTX — **known UI gap**, listed in the final report.
- **HIGH-RISK boundary:** files >512 KB have no side-car and cannot round-trip
  (export original/docx unavailable). Verify the app fails loudly, not with a
  corrupted file.

### 1.5 Offline round trip (export → external CAT → re-import)
API-level only (matcher: `src/lib/import/xliff-reimport.ts`); no UI yet.
Covered by `parity/acceptance/workflow-tm.test.ts`. Manual: run
`pnpm vitest run --config parity/vitest.config.ts parity/acceptance/workflow-tm.test.ts`.

## 2. Export fidelity warnings (inline styles) — NEW, user-facing

**Risk rating: LOW** (pure additive UI), but HIGH value to verify.

1. Import a dev `xliff12` file that has inline tags (e.g. any with `<g`/`<bpt`
   visible in a text editor).
2. Edit a tagged segment's translation to arbitrary new text.
3. Export as XLIFF. After "Downloaded…", an amber panel must list that
   segment: "edited translation cannot reuse the imported XLIFF inline tags…".
4. Export again without editing anything (fresh import): NO amber panel.
5. DOCX with mixed-run paragraph (bold+plain in one paragraph): export after
   translating it → warning "mixed inline formatting…".

## 3. Analysis / payable words

**Risk rating: LOW** (pure functions).
Run `pnpm vitest run --config parity/vitest.config.ts parity/acceptance/analysis.test.ts`.
Spot-check by hand: "Hello, world!" = 2 words; "請在使用前" = 5; a URL = 1;
payable maths per the table in `src/lib/analysis/payable.ts` (New 100%,
Reps 30%, Internal 60%, TM100 30%, ICE 0%, MT 77%).

## 4. QA checks (tags / whitespace / symbols / numbers / conflicts / glossary)

**Risk rating: MEDIUM** — the checks are correct per tests, but they are not
yet wired into the editor UI (library level only; the existing rules/health
surface is unchanged).
Run `pnpm vitest run --config parity/vitest.config.ts parity/acceptance/qa.test.ts parity/acceptance/workflow-tm.test.ts`.
Glossary spot-check: build a termbase CSV with header
`forbidden,en-US,fr-FR,notes`, rows `,Save,Enregistrer,` and
`TRUE,Save,Sauvegarder,`; `parseTermbaseRows` + `checkGlossary` must flag a
target using "Sauvegarder" and a target missing "Enregistrer".

## 5. Batch translation API (contract + throughput)

**Risk rating: MEDIUM** — the stub is the reference; the REAL endpoint does
not exist yet and must be tested against this exact suite when it lands.

```bash
pnpm vitest run --config parity/vitest.config.ts \
  parity/acceptance/batch-contract.test.ts parity/acceptance/batch-throughput.test.ts
```

All 10 must pass; the throughput test logs its seg/min rate (bar: ≥2,000/min).
Contract of record: `BATCH_ENDPOINT_CONTRACT.md` (frozen). Any real-endpoint
deviation is a defect in the endpoint, not the contract.

## 6. Enterprise-exclusion & TM-opt-out canaries (CRITICAL — data governance)

**Risk rating: HIGH consequence, LOW likelihood.** One leak = release blocker.

### 6.1 Automated reproduction (exact steps)
```bash
pnpm vitest run --config parity/vitest.config.ts parity/acceptance/tm-governance.test.ts
```
This seeds orgs `org-ent-1`/`org-ent-2` flagged enterprise with canary strings
(`CANARY-ENT-ALPHA-7f3e`, `CANARY-ENT-BRAVO-2c91`, `CANARY-ENT-CHARLIE-e04d`)
and an opted-out project (`proj-optout-1`, canaries `CANARY-OPTOUT-DELTA-9d2c`,
`CANARY-OPTOUT-ECHO-51aa`), then runs 500 randomized queries plus exact /
near-match / marker-substring / cross-language red-team probes. **Every test
must pass; any surfaced canary is a critical failure.**

### 6.2 Manual library-level probe
In `pnpm vitest --watch` or a scratch test, build the seeded world exactly as
in `parity/acceptance/tm-governance.test.ts` (`seedWorld()`), then call
`index.retrieve({ query: "CANARY-ENT-ALPHA-7f3e", sourceLang: "en-US",
targetLang: "fr-FR", limit: 10 })` — result must be `[]`, while a query for
"Click Save to apply" must return normal-org entries.

### 6.3 Flag semantics to verify
- `org_settings.settings.enterprise: true` → org excluded from retrieval.
- `project_settings.settings.contributeToGlobalTm: false` → zero new writes
  (write gate) AND legacy rows unreachable (read filter).
- Default (absent flag) = contribute TRUE. Opt-out requires the paid feature
  (billing stub currently grants it to everyone — re-test when real billing
  lands: an UNENTITLED opt-out must keep contributing and report
  `canConfigureTmOptOut: false`).

### 6.4 When the Worker wiring lands (future)
Re-run 6.1 against the real route; additionally seed a REAL D1/PG database
with an enterprise org + canaries and query via HTTP. The library filter must
be re-verified end-to-end — do not assume SQL pre-filtering replicates it.

## 7. EXCEEDS regression guards (must never regress)

```bash
pnpm test src/lib/completion/completion-service.test.ts src/lib/completion/batch-completion.test.ts \
  src/lib/health/decay-engine.test.ts src/lib/health/decay-settings.test.ts \
  src/lib/event-names.test.ts src/lib/sync/outbox.test.ts \
  src/lib/parsers/subtitle.test.ts src/lib/export/vtt-voice.test.ts
```
Plus in-app: multi-model attribution in history drawer ("by {model}"), health
gutter overlay, offline edit → reconnect → sync.
