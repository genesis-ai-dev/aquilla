# Aquilla QA skills runner — Biblica

Biblica's 13 `qa-*.md` skill files, run against an Aquilla project **over the Agent
API**, with every result staged as a changeset a person approves. Nothing this runner
produces changes a cell, validates anything, or approves a term.

Tracked as [AQU-2365](https://linear.app/frontierrandd/issue/AQU-2365). The skill files
are in [`skills/`](skills/) **verbatim** — they are the specification, and they are not
edited to suit this surface. Where the API cannot do what a skill asks, this README says
so rather than quietly changing the skill.

## Why this is not the in-app agent

Biblica's own install guide says: upload the 13 files to the Knowledge base, paste the
operating rules into the Project brief, and type `Run qa-run-book on MRK`. Two of those
three steps cannot work in production today:

- the in-app agent has **no tool that reads the Knowledge base**, so it cannot open a
  skill file by name;
- `AGENT_SANDBOX_URL` is unset in production and dev, so `run_code` and `load_artifact`
  answer "sandbox unavailable" — and the skills' core rule is that *"counts, inventories,
  verse lists and pattern checks must be done with sandbox code, not by reading"*.

So the computational passes run here, where there is a real interpreter, and every read
is a plain authenticated GET. The in-app path (sandbox in production plus a
Knowledge-base-reading tool) is a follow-up, not a prerequisite.

## What runs as code, and what does not

| Pass | Skills | Here |
| --- | --- | --- |
| 0 Bootstrap | `qa-bootstrap-inventories` | **code** — the six verification CSVs |
| 1 Mechanical | `qa-chapter-verse`, `qa-text-integrity`, `qa-characters-punctuation`, `qa-capitalization-numbers` | **code**, Confidence High |
| 2 Spelling | `qa-spelling-wordlist` | **code**, Confidence High |
| 3 Consistency | `qa-key-terms-names` | **code**, over `terms` + `terms/consistency` |
| 3 Consistency | `qa-parallel-passages` | model pass, over the corpus this run writes |
| 4 Meaning | `qa-meaning-fidelity` | model pass — never Confidence High |
| 5 Publish | `qa-notes-headings-names`, `qa-publish-readiness` | model passes |
| 0 optional | `qa-grammar-profile` | model pass; its verified affixes feed Pass 2 |

Every run names the passes it did not execute in the report's **Not checked** section, so
a mentor is never left to assume a pass ran.

The division is the point of the confidence column. `qa-run-book.md` defines High as
"verified by code", and the harness enforces it: a finding marked as model-produced
**cannot** be constructed with High confidence, and a Low-confidence finding **cannot** be
anything but a Query. Both rules raise an error at construction rather than being left to
each checker to remember.

## Install

### 1. Two tokens

A signed-in human mints both in the Aquilla app: **Preferences → Account → API tokens**.
Each `aqk_…` token is shown exactly once.

| Token | Access | Autonomy | Scope | Used for |
| --- | --- | --- | --- | --- |
| read | `read` | either | the project (or its org) | every GET |
| write | `write` | **`ask`** | the project (or its org) | staging changesets only |

Two tokens, not one, on purpose: the reads cannot write, so a bug in a checker cannot
reach the write path at all. **Leave PII off** — the skills never need a username, and
`lastEditor` pseudonyms are enough for "edited since approval".

Ask mode is not optional. In `act` mode a commit applies immediately; the skills require a
person to approve every finding, so the write token must be `ask`.

```bash
export AQUILLA_SYNC_HOST=https://api.aquilla.app/sync   # the /sync prefix is part of the URL
export AQUILLA_READ_TOKEN=aqk_…
export AQUILLA_WRITE_TOKEN=aqk_…
```

Tokens are read from the environment and never taken as arguments: an `aqk_` token on a
command line lands in the shell history and in the process list.

### 2. The four input files

The API cannot supply these, and they are **not** read from the Knowledge base. Put them
anywhere and pass the paths:

| File | What it is | Used by |
| --- | --- | --- |
| `keyterms.csv` | the Biblica Key terms list, `source term,list id`, in the **source text's** language | `qa-bootstrap-inventories`, `qa-key-terms-names` |
| `parallel-passages.md` | converted from `ParallelPassages.xml` (the KB does not take XML) | `qa-parallel-passages` |
| grammar paper | PDF/DOCX, optional | `qa-grammar-profile` |
| `approved-books.txt` | one book code per line, or one comma-separated line; `#` comments allowed | the bootstrap and the edited-cells mode |

The approved-books list is an input, not a guess. The bootstrap **refuses** to run if the
corpus contains a book that is not on it — `qa-bootstrap-inventories.md` → Do not.

### 3. Project brief

Paste the *QA operating rules* block from [`skills/README.md`](skills/README.md) into the
Project brief and fill in the source text and the approved books. The brief is injected
verbatim into the agent prompt, so this is what the model passes read.

### 4. Built-in checks and agent mode

In the app: **Living Memory → Translation quality**, switch on every built-in check except
*USFM markers* and *Length mismatch*. Set agent mode to *QA only*, scope *Checks only*.

## Run it

```bash
cd agents/qa-biblica

# Pass 0 — build the six verification CSVs from the approved books
python3 -m qa_biblica --project proj_abc bootstrap \
  --approved-books ~/biblica/approved-books.txt \
  --key-terms ~/biblica/keyterms.csv \
  --out ~/biblica/out

# Pass 1-5 on a remaining book
python3 -m qa_biblica --project proj_abc run-book MRK --source-text NIV --out ~/biblica/out

# Pass 1-4 on one chapter
python3 -m qa_biblica --project proj_abc run-book "ROM 3" --out ~/biblica/out

# Pass 1-3 on approved books, edited cells only
python3 -m qa_biblica --project proj_abc edited \
  --approved-books ~/biblica/approved-books.txt --edited-since 2026-09-30 --out ~/biblica/out

# Render everything, call no prepare — for CI and for a rehearsal
python3 -m qa_biblica --project proj_abc run-book MRK --dry-run --out /tmp/qa
```

Add `--lane <laneId>` if the project has several language lanes; without it the runner
reads the lane off the first target row, because an omitted lane is not "the default one".

### What you get

| Output | Where |
| --- | --- |
| `qa-report.md` | the `qa-run-book` report, in that file's exact format |
| `corpus.jsonl` | every cell the run read — the evidence behind every count |
| `new-words.csv` | `qa-spelling-wordlist`'s new-word list, with an empty Decision column |
| `characters.csv`, `punctuation.csv`, `conventions.csv`, `wordlist.csv`, `keyterms.csv`, `names.csv` | the bootstrap's verification lists |

### What to click

The report is staged as **one `comment.create` on the first cell of the scope**. In ask
mode the run prints an approval URL and stops:

```
Nothing is written until a person approves. Open each link and click Approve:
  https://aquilla.app/approve/cs_…
```

Open it, read the staged comment, click **Approve**. The comment then appears in Aquilla on
that cell. Staged changesets expire after 1 hour and approval expires 15 minutes after
granting, so approve promptly or re-run.

`--finding-comments` additionally stages one comment per finding, batched at 200 events per
changeset (the API's `EmitEvents` limit). It is off by default: the skills' primary artefact
is the one report, and a mentor who has not asked for 200 cell comments should not get them.

### After the team verifies the bootstrap

Fill the **Decision** column in each CSV, then:

```bash
python3 -m qa_biblica --project proj_abc bootstrap-verified \
  --csv ~/biblica/out/characters.csv --out ~/biblica/out
```

That stages the baseline as `AddDecision` entries and writes `termbase-import.csv`
(approved renderings *required*, rejected ones *forbidden*) for the Project lead to import.
Nothing is applied until approved.

## Baseline path mapping (read this once)

The skills name the baseline notes `style/characters`, `glossary/wordlist-approved` and so
on. The Agent API's memory paths are a **flat namespace per kind** — `decisions/<slug>.md`
with the slug matching `^[a-z0-9]+(-[a-z0-9]+)*$` — so a slash cannot be expressed. The
runner folds the prefix into the slug and the skills are left unedited:

| Skill's path | Memory path actually used |
| --- | --- |
| `style/characters` | `decisions/qa-style-characters.md` |
| `style/punctuation` | `decisions/qa-style-punctuation.md` |
| `style/quotations` | `decisions/qa-style-quotations.md` |
| `style/conventions` | `decisions/qa-style-conventions.md` |
| `style/grammar-profile` | `decisions/qa-style-grammar-profile.md` |
| `glossary/wordlist-approved` | `decisions/qa-glossary-wordlist-approved.md` |
| `glossary/wordlist-incorrect` | `decisions/qa-glossary-wordlist-incorrect.md` |
| `glossary/names` | `decisions/qa-glossary-names.md` |

Only **approved** entries count as baseline. A proposed entry is a suggestion the team has
not accepted, and treating it as the standard would be the runner approving its own work.

`qa-run-book.md` requires the baseline to exist before any pass runs. With a required list
missing — or with no active termbase concept — the run **stops**, writes a report saying
what it read and what is missing, and stages nothing.

## What it will not do

Enforced in [`qa_biblica/stage.py`](qa_biblica/stage.py) and driven directly by
`tests/test_stage_contract.py`. The guard runs **before any request is built**, so a
forbidden kind cannot reach the wire through a new call site or a hand-rolled command list:

- **Allowed:** `EmitEvents` (carrying `comment.create`, and `term.create`/`term.update` in
  the after-verification step only), `AddDecision`, `AddNote`.
- **Refused outright:** `SetTranslation`, `SetSource`, `cell.validate`, `cell.unvalidate`,
  `cell.waive`, `cell.unwaive`, `term.approve`, `term.reject`, `term.delete` — each with a
  message saying why. A finding having an obvious fix does not change this.

A read-only token hitting the write step gets the API's `scope_denied`, and the run says so
loudly and **keeps every file it produced**. That is not retryable: only a human minting a
new token can lift a token's access ceiling.

## Re-running is safe

The report footer and every per-finding comment carry a short fingerprint of the finding.
A later run reads its own previous comments off the anchor cell and drops anything already
reported, so re-running an unchanged scope produces no new findings and stages nothing. The
run log says `12 finding(s) after grouping, 12 already reported, 0 new` rather than looking
like it found nothing.

## Known gaps (filed, not hidden)

Each of these is reported in the run's **Not checked** section with the reason:

- **Per-cell built-in violations** are not readable over the Agent API — `quality` is
  file-level health and coverage. The runner knows *which* checks are on and cites them by
  name, as `qa-run-book.md` asks, but cannot merge built-in findings verse by verse.
- **No back-translation read**, so `qa-meaning-fidelity`'s doctrinal guardrails can only
  point the mentor at the verses where a guarded concept occurs in the **source**. Those
  findings are Low-confidence Queries and say so.
- **Knowledge-base reads** are not used: the four Biblica inputs come from disk.
- **Bridge mismatch** is not observable — a cell has one `canonicalRef` shared by its source
  and target rows, so a target-only bridge cannot be seen over the API. The visible half of
  the symptom (one long cell beside a near-empty one) is reported as *Merged verses*.

## Tests

```bash
cd agents/qa-biblica
python3 -m unittest discover -s tests -t .     # stdlib only, no install
```

They also run as part of the repo's suite (`pnpm test`) through
[`vitest.config.mts`](vitest.config.mts), so this code is covered by the same gate as
everything else. Coverage: the Pass 1-3 checkers against Latin-script, Arabic-script and
plain-text fixture corpora; the command-kind contract; the dry-run mode; the read-only and
unreachable-project paths; idempotency; and the edited-cells scope.

## Dependencies

None. Python 3.9+ and the standard library. The issue's design decision said "stdlib +
`requests`"; nothing here needed more than `urllib`, so the dependency was dropped — the
people running this are translation mentors, and a `pip install` step is a step that fails.
