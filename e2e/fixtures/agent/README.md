# Agent import fixtures

Fixtures for the AQU-AGENT sandbox agent e2e journey (`e2e/specs/agent-import.spec.ts`):
"messy real-world upload → agent inspects/parses it in the sandbox → stages a
`PlanImport` changeset → human approves." Each file is deliberately messy in a
way a real translation org's export pipeline actually produces — not
synthetic edge-case soup — so the fixture doubles as a regression case for the
harness's `load_artifact` / `run_code` (pandas/openpyxl) tools per
`docs/swarm/AQU-AGENT-CONTRACTS.md` §1–2.

## `mixed-notes.csv`

A CSV a project coordinator hand-exported from a spreadsheet and lightly
edited. Traps, line by line:

- **BOM** (`﻿`) at the start of the file — a naive `fs.readFile(...,
  "utf8")` + `split(",")` parse leaves it stuck to the first header cell.
- **Row 1 is a merged-header artifact**, not real columns (`Translation
  Export — Q3 batch...` in col A, blanks elsewhere) — the real header row is
  row 2. An agent that treats row 1 as the header will get `ID`/`Source
  Text`/... as *data*, not column names.
- **Delimiter drift**: most rows are comma-delimited, but two rows (id 2 and
  the "9;Second batch..." row) revert to semicolons — as if two exports got
  concatenated.
- **Unescaped inner quotes** (id 3): `Il a dit "arrête maintenant" et est
  parti` breaks naive CSV quote-matching (no doubled `""`).
- **Swapped source/target columns** (id 4): the Amharic text is in the
  "Source Text" column and the English gloss is in "Target Translation" —
  backwards from every other row. Row 5 does the same with Hindi. An agent
  should notice the language mismatch against the project's declared
  source/target languages rather than import it silently reversed.
- **Missing target** (id 6) and **missing source** (id 8) — both should
  surface as warnings in the staged changeset's effect summary, not silently
  drop the row or silently synthesize the missing side.
- **Blank line** between id 7 and id 8 — must not be treated as a
  file/section boundary.
- **Embedded newline inside a quoted field** (id 10) — a line-based (not
  RFC4180-aware) parser will split this into two malformed rows.
- **Non-Latin scripts**: Amharic (Ge'ez) and Hindi (Devanagari) rows exercise
  non-ASCII/RTL-adjacent-script handling end to end (encoding, sandbox
  round-trip, changeset preview rendering).

Expected agent behavior: recognize the merged title row and skip it, pick the
real header row, flag (not silently fix) the delimiter drift and the swapped
source/target rows, and produce a `PlanImport` changeset whose warnings list
every row it couldn't confidently resolve (missing source/target) rather than
dropping them.

## `legacy-export.csv` + `legacy-export.xlsx`

A "legacy TMS export" — the kind of flat dump an older translation-management
system produces when someone clicks "Export to Excel." `Ref` uses Scripture
reference IDs (`GEN.1.1`) that a numeric/date-guessing importer might try to
coerce; `Status` carries all-caps workflow codes (`APPROVED` / `DRAFT` /
`NEEDS_REVIEW` / `PENDING`) that are not part of the translatable text and
must not be imported as source/target content. Some rows have an empty
`FR` (target) or empty `EN` (source) cell.

`legacy-export.xlsx` is the **same data** as `legacy-export.csv`, generated
with `generate-xlsx.mjs` (see below), so the two exercise CSV vs. XLSX parsing
against an identical fixture. It additionally exercises two xlsx-only traps:

- **A merged title cell** over `A1:F1` (`mergeCell ref="A1:F1"`) — analogous
  to `mixed-notes.csv`'s merged header row, but expressed as a real OOXML
  merge rather than empty trailing cells.
- **A fully blank interior row** (row 5, between `GEN.1.2` and `GEN.1.3`) —
  common when an export comes from a filtered view and the filter leaves a
  gap; must not be treated as an end-of-data marker.

### `generate-xlsx.mjs`

Neither `exceljs` nor `xlsx` is in this repo's lockfile (checked
`pnpm-lock.yaml` before writing this), and the swarm build rule is "use a dep
only if it's already there." So this script hand-builds a real, valid `.xlsx`
— it constructs the ZIP container itself (local file headers, central
directory, EOCD, a hand-rolled CRC-32 table) using only Node's built-in
`zlib.deflateRawSync`, and writes minimal-but-correct OOXML parts
(`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
`xl/_rels/workbook.xml.rels`, `xl/styles.xml`, `xl/worksheets/sheet1.xml`)
using inline strings (`t="inlineStr"`) so no `sharedStrings.xml` part is
needed. No dependency was added to any `package.json`.

Regenerate with:

```bash
node e2e/fixtures/agent/generate-xlsx.mjs
```

This overwrites `legacy-export.xlsx` deterministically (fixed embedded
timestamp, so the output is byte-identical across runs on the same Node
version). Verified against both `unzip -t` (structural ZIP validity) and
Python's `openpyxl.load_workbook()` (a real, independent XLSX parser reading
back all 9 rows correctly) at fixture-creation time — see
`docs/swarm/AQU-AGENT-TRACES.md` for the trace note; CI has no `openpyxl`
step, so re-verify manually after editing this script.

**Gap**: the sandbox's Tier-2 Python stack per contracts §1
(`pip install pandas openpyxl ...`) is the intended xlsx reader; this
generator was not run *through* the actual agent-worker sandbox as part of
this task (sandbox worker doesn't exist yet — W1A is building it in
parallel). Once the sandbox is up, add an assertion in
`agent-import.spec.ts` (or a lower-level agent-worker test) that
`load_artifact` + a `pandas.read_excel` snippet against this fixture
round-trips the 9 rows including the merged-cell title and the blank row.

## `interview-transcript.txt`

A hand-transcribed bilingual (Amharic / Hindi ↔ English) fieldwork interview
with speaker labels and timestamps, formatted inconsistently the way a human
transcriber actually types under time pressure:

- **Timestamp formats vary**: `[00:00:00]`, `00:00:12 -`, `[00:01:03]` with
  extra leading whitespace, bare `00:02:50 -`, and a bracketed range marker
  `[unclear — overlapping speech, 00:01:45]` that isn't a real speaker turn.
- **Speaker-label formats vary**: `INTERVIEWER:`, `ELDER (Amharic):`, `Q:` /
  `A:` shorthand, and `Interviewer —` / `Elder —` (em dash, no colon) after
  the recorder restart.
- **Code-switching mid-turn**: the interviewer asks one question in Hindi
  mid-session with no formatting cue other than the parenthetical
  `(in Hindi, code-switched mid-question)`.
- **An inline (not offset/footnoted) translator's gloss** embedded in one
  turn — text that is commentary about the transcript, not transcript
  content, with no structural marker distinguishing it.
- **A discontinuous timestamp sequence**: the recorder is explicitly noted as
  restarted mid-session, resetting to `00:00:00` — a naive agent that assumes
  monotonically increasing timestamps (e.g. to infer chronological order or
  to split into "chapters" by time gaps) will get session ordering wrong.
- **An explicit unreliability note** at the end (recorder metadata doesn't
  match the timestamp math) — the agent should not silently "correct" the
  arithmetic or invent a canonical timeline.

Expected agent behavior: segment by speaker turn (not by timestamp format),
preserve both languages as separate translatable units (or flag the
code-switched turn for human disambiguation rather than silently picking one
language), and surface the timestamp discontinuity/unreliability as a warning
rather than silently normalizing it into a single monotonic sequence.
