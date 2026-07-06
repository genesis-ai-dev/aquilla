# The Effort Report — How "Results Without Effort" Actually Gets Delivered

**Date:** 2026-07-06 · **Author:** Engineering lead · **Audience:** growth-stage investor, skeptical of services-shaped SaaS

**Method note (read first).** Every effort claim below is derived from this repository's full commit
history (2,389 commits, 2026-04-13 → 2026-07-06, recovered by unshallowing the clone), from code that
exists today at the cited paths, or from test suites re-run for this report on 2026-07-06. Where a
claim cannot be verified from this repo, it is marked **UNVERIFIED**. Hour figures are commit-span
estimates, not timesheets; where a step has no commit trail (e.g. a translator clicking through the UI)
the figure is a walkthrough estimate and is labeled as such.

---

## 1. Executive summary

**Are we a machine or a workshop?** We are a machine for *getting content in and out losslessly* —
for the format classes we have built — and a workshop for *keeping it flowing*. The importer cost
curve inside this codebase is measurably compounding: the most recent real-publisher format (UBS's
62 MB SDBH lexicon XML) went from design spec to a working importer **with a byte-identity round-trip
proof against all 17 real 60–73 MB editions in under two engineer-days** (spec: two commits,
2026-06-17 15:09–15:24; implementation: two commits, 2026-07-02 08:36–09:03). It was substantially
agent-written, like 62% of this codebase (1,487 of 2,389 commits carry AI co-author trailers). One
scoping caveat, stated up front: the format that took months in the predecessor product — **IDML
(Adobe InDesign), the print-typesetting case** — has not been rebuilt here; this repo contains zero
IDML code. §3 argues from the mechanism why it lands in the same 2–5-day class as SDBH, and §8 funds
a timeboxed spike to prove it rather than assume it.

**The honest finding is that the risk moved.** The repeating cost is no longer "write the importer" —
it is that **every content update costs the same human clicks, forever**. Of the six links in the
"content in → output out, unattended" loop, exactly one exists today (the audit trail). Change
detection, incremental re-translation, unattended translation runs, automatic review queuing, and
automatic re-export are all absent from the product: every pipeline stage is initiated by a human in a
browser tab that must stay open (§6). That recurring, customer-side effort is the churn column.

**Single biggest bottleneck by hours:** the operational loop — per-content-update initiation plus
per-cell review — not importer engineering.

**The one bet:** build the continuous-loop substrate first (~5 engineer-weeks). Every primitive it
needs already exists in the codebase as a script, a query, or a badge; none of them are wired to run
without a human. Wiring them converts 7 human-initiated stages per content update into 1 (review).

---

## 2. The Effort Map — where human hours go today

End-to-end trace for our most recent onboarding motion (Come and See, the dubbing/translation
operation behind The Chosen, migrating off the desktop Codex app + GitLab —
`docs/come-and-see-anna-qa-checklist.md`), cross-checked against the newest publisher intake (UBS /
SDBH). Actors: **ENG** = our engineer, **ADMIN** = customer org admin, **TRANS** = customer
translator/reviewer. **The Operational column is the churn-risk column.**

| # | Step | Actor | Hours (evidence) | Setup / **Operational** |
|---|---|---|---|---|
| 1 | Intake & format analysis | ENG | SDBH: ≤ 0.5 day. The design spec containing measured file facts (7,932 lemmas, 16,934 senses, 23,809 CON nodes) was committed the same afternoon it was written — two commits 15 min apart, 2026-06-17 (`docs/superpowers/specs/2026-06-17-sdbh-importer-design.md`) | Setup, per format |
| 2 | Importer development | ENG (agent-written, engineer-verified) | SDBH: ~0.5–1 day — parser (387 loc) + lossless exporter + 281-loc test suite + round-trip script landed in two commits 27 min apart on 2026-07-02 (`src/lib/parsers/sdbh.ts`, `scripts/sdbh-roundtrip-check.ts`). Historic worst case in this repo: the USFM/Paratext cluster, 23 commits across 9 files (~2,100 loc + ~1,300 test loc) spread over Apr 13 – Jun 19 ≈ 6–8 active engineer-days | Setup, per format |
| 3 | Legacy-system data migration | ENG | Come and See is a **desktop-app→web migration**, not a format problem — their formats (subtitle import, per-character audio export) were already in-product. The migration tooling was built Jun 1–3 (3 active days, `scripts/migrate-all.ts`, `migrate-users.ts`, `migrate-groups.ts`) + supervised runs. **This is pure services work** — GitLab-specific, per-publisher | Setup, per publisher |
| 4 | Org/teams/roles/invites | ADMIN | ~1–2 h in-product (walkthrough estimate; flows at `src/components/SharePanel.tsx`, `MembersPanel.tsx`; journey rows `e2e/JOURNEYS.md:14-22`) | Setup |
| 5 | Project + AI provider + settings + rules/terminology/brief seeding | ADMIN | ~2–8 h (walkthrough estimate; `ProjectCreateDialog.tsx`, `AiSetupDialog.tsx`, `ProjectSettings/`, `RulesPage.tsx`, `TerminologyPage.tsx`, `BriefBuilder.tsx`) | Setup, grows over time |
| 6 | Import per content drop | TRANS | 5–15 min per batch: format auto-detected (`detectFileType`, accept list of 30 extensions, `ImportDialog.tsx:1128`); human decides source-vs-target for Paratext, per-book include/exclude preview, collision skip/duplicate, spreadsheet column mapping | **Operational** |
| 7 | Translation runs | TRANS | Attended browser session: "Translate" runs a sequential in-tab loop, ≤30 cells per call, tab must stay open (`src/lib/completion/batch-completion.ts:26-28`, `useCompletion.ts:52`). ~0.5–2 h attended per ~1,000 cells (walkthrough estimate) | **Operational** |
| 8 | Review loop | TRANS | Dominant recurring human hours, scales with content: per-cell validation click (`SelectionBar.tsx:142-194`), comments, violation triage, back-translation checks. Minutes per cell. This is also the product's value — the audit trail is built from these gestures | **Operational** (partly irreducible by design) |
| 9 | Audio (dubbing path) | TRANS | Largest per-unit labor: per-cell record→review→save/retake (`AudioRecordingModal.tsx:165-241`), or TTS+cast assignment (few clicks/cell, `CellVoicePanel.tsx`); diarization is one click + optional speaker-count hint (`run-diarization.ts:33`) | **Operational** |
| 10 | Output rendering & delivery | TRANS | 2–5 min per delivery via ExportDialog (13 formats; USFM/DOCX/SDBH-XML lossless via sidecar; VTT; one-WAV-per-character stems). Several formats are per-file only; project zip capped at 40 files (`ExportDialog.tsx:247-251,671-678`). Delivery = manual download + hand-off. **No print/PDF typesetting exists** (no PDF code under `src/lib/export/`) | **Operational** |
| 11 | White-label brand (optional) | ENG | ~0.5–1 day: hand-authored brand data + theme file + deploy route (`src/branding/brands/*.data.ts`) | Setup |
| 12 | Platform infra (Modal GPU diarization/voice-clone, worker routes) | ENG | One-time platform cost, already sunk (`infra/modal/diarization.py:1-30`); not per-publisher | Setup, platform |

Two reading notes. First, rows 1–3 are the only rows that require **our** engineers, and rows 1–2 have
already collapsed to ~1–2 days (see §3). Row 3 only exists for publishers migrating from a legacy
system. Second, every **Operational** row shares one property: a human initiates it, every time. None
of it re-runs when the publisher's source changes. That is the machine gap, and it is quantified in §6.

---

## 3. Importer Post-Mortem — the months, dissected

**Where the "months" actually lived.** The months-long importer effort was the **IDML (Adobe
InDesign) importer** in the predecessor product — the Codex VS Code desktop extension described in
`docs/SPEC.md` (separate repository, `genesis-ai-dev/codex-editor`). Its commit history is not in this
workspace, so the "months" figure is **UNVERIFIED here** and I will not lean on it. Two verifiable
facts frame it instead:

1. This repo was started from scratch on 2026-04-13, and **no importer in it has ever taken more than
   ~8 active engineer-days** — the desktop-era knowledge arrived as design decisions, not reusable code.
2. **Aquilla contains zero IDML code** — no parser, no doc, no test mentions IDML or InDesign
   (repo-wide search, 2026-07-06). The months-problem has not been re-solved here; the format class is
   absent. The cost-curve claim below is therefore scoped to the format classes actually built
   (scripture/USFM, subtitles, Office, spreadsheets, CAT, lexicon XML), and the IDML class gets a
   funded experiment in §8, not an extrapolation.

**Why IDML is expected to land in the SDBH class, mechanically (hypothesis, not evidence).** IDML is a
zip of XML files with stable story/paragraph structure — the same shape as the two hardest things
already working: DOCX/PPTX (OOXML zip surgery with raw side-car retention, client-side JSZip
injection, `src/lib/export/exporters/docx.ts`) and SDBH (keyed reinjection into a retained XML
skeleton, byte-identity checked, `src/lib/parsers/sdbh.ts`). Typesetting intent — the thing that made
IDML take months to *model* — is exactly what the side-car pattern refuses to model: the original IDML
stays the canonical structure, translated text is re-injected into its text runs, and the publisher's
own InDesign toolchain does the typesetting. The failure mode that consumed months in codex-editor
(reconstructing InDesign semantics) is the approach this architecture was built to avoid. The §8 spike
(2–5 days, real publisher IDML, byte-identity harness) is the test that turns this paragraph from
hypothesis into a row in the cost table.

### Taxonomy of difficulty (from the importers actually built)

| Difficulty | Real example | Where solved |
|---|---|---|
| **Formatting-as-meaning** | USFM: ~150 markers where poetry indentation (`\q1-4`), footnotes (`\f…\f*`), red-letter (`\wj`) carry typesetting intent; modeling all of them is called "a tar pit" in the code itself | `src/lib/parsers/usfm-lossless.ts:1-20` |
| **Implicit structure** | Paratext bundles with no `Settings.xml` (partial bundles detected by heuristic); verse-ref alignment of a target translation against a different source edition | `paratext-project.ts` (commit d562ddcd, 2026-05-31); `paratext-pairing.ts` |
| **Scale + hierarchy** | SDBH: 62 MB XML, 5-level hierarchy with stable IDs, a 23,809-node contextual layer whose semantics required a question back to the publisher's editor (recorded as an open design question, not guessed at) | spec §2, `docs/superpowers/specs/2026-06-17-sdbh-importer-design.md`; commit 13a6816a |
| **In-corpus inconsistency** | SDBH: up to ~3k empty `<Gloss />` editor artifacts per edition — handled as the *one* documented normalization in the byte-identity check | `scripts/sdbh-roundtrip-check.ts:45-53` |
| **Encoding/quoting traps** | RFC-4180 quoting (commas, embedded newlines) in CSV; unescaped `"` corrupting TSV re-import — caught and documented by the round-trip suite, not by a customer | `docs/swarm/ROUNDTRIP-FIDELITY.md`; `cat-roundtrip.test.ts` |
| **Binary containers** | DOCX/PPTX: OOXML zip surgery; mixed inline bold/italic collapses to the dominant run (a known, documented loss) | `src/lib/export/exporters/docx.ts:9-35` |

### Transferability audit — what publisher #1 left behind

Four assets transferred; each is cited to the code and to the dates it was reused.

1. **One canonical importer contract.** Every parser emits `TranslatableString[]`
   (`src/lib/parsers/types.ts:17-58`) into a single ingestion path
   (`emitParsedFile`/`bulkUploadSource`, `src/lib/import.ts:823-939`). All 30 parser modules target it.
   A new importer inherits ingestion, preview, collision handling, and sync for free.
2. **The lossless side-car + keyed-reinjection pattern.** Don't model the format's 150 markers — keep
   the original bytes as the structural skeleton and re-inject translated text at keyed positions.
   Invented for USFM (2026-05-30, `usfm-lossless.ts`), generalized to DOCX/PPTX raw side-cars
   (2026-06-04, commit "FRO-152"), reused for SDBH XML (2026-07-02). Three formats, one pattern, each
   reuse cheaper than the last.
3. **The round-trip harness pattern.** Machine-checked fidelity instead of human code review:
   `cat-roundtrip.test.ts` generates the format-by-format loss report in
   `docs/swarm/ROUNDTRIP-FIDELITY.md`; `sdbh-roundtrip-check.ts` proves byte-identity against real
   publisher files. **Re-run for this report on 2026-07-06: 74/74 tests pass across the 4 round-trip
   suites in 1.8 s.**
4. **Agents write the importers.** This already happened; it is not a roadmap item. On 2026-05-31 a
   multi-agent swarm produced the XLIFF, TMX, CSV, and TSV importers *and* their exporters *and* the
   fidelity report in one day (squash-merge 00fdbd81, 17:29, "Co-Authored-By: Claude Sonnet 4.6"). The
   SDBH importer carries an AI co-author trailer too. 1,487 of 2,389 commits (62%) are AI-co-authored;
   92% of commits are attributed to one human engineer directing that work.

What did **not** transfer: format-specific glue is real but small and quarantined inside each parser
file (e.g. SDBH's gloss-artifact normalization, Paratext's partial-bundle heuristic). None of it leaks
into the pipeline.

### The cost curve

- **The platform + first format wave (serving Come and See's workflow):** 12 weeks of repo history, of
  which the import/export surface specifically is ~160 commits touching 43 of 84 calendar days. Come
  and See itself is a **desktop→web migration**, not a novel-format case — their operational formats
  shipped in-product early (subtitle import with speaker→cast auto-mint, 2026-04-13 onward;
  per-character audio-stem export, 2026-05-31, e2e-covered 2026-06-02). Their onboarding cost is §2
  row 3 (migration scripts), not importer work.
- **First post-platform novel format (UBS/SDBH, 62 MB proprietary XML):** ≤ 2 engineer-days, measured
  by commit timestamps (§2 rows 1–2), including the correctness proof.

Importer marginal cost for a new format in a built class: **~5% of the first-wave cost, not 80%** —
with the explicit boundary that the IDML/print class is unproven here (see above) until the §8 spike
runs. The numbers that have *not* fallen: §2 row 3 (legacy-system migration — services work whenever a
publisher arrives with an incumbent system) and the operational rows, which don't fall with publisher
count at all until §8 bet 1 is built.

---

## 4. The Canonicalization Question

**A canonical core exists, but it is deliberately two-tier — and one honest gap follows from that.**

**Tier 1 — the canonical cell.** All 30 importers emit `TranslatableString[]`; all of it lands in one
`cells` table (source and target as two rows sharing a `cell_id`, `db/postgres/schema.sql:329-367`).
First-class fields: bilingual text, HTML, canonical reference, **subtitle timing** (`start_ms`/`end_ms`),
sequence, medium, paragraph-start, cast/speaker (routed to project cast assignments,
`src/lib/import.ts:853`), plus a `metadata` JSONB bucket (OBS images). The CAT round-trip suite proves
this tier is lossless for bilingual text through XLIFF/TMX/CSV export-reimport **from cells alone**
(`cat-roundtrip.test.ts`, 74/74 green).

**Tier 2 — the source side-car.** Publishing semantics — footnotes, cross-references, poetry and
typesetting intent — are *not* modeled as fields. They survive because the original bytes are retained
(`file_source_blobs`) and exports re-inject translated text into that skeleton (USFM:
`sync-worker/src/events/export-route.ts:74-204`; DOCX/PPTX: raw side-car + client-side injection; SDBH:
keyed `LEXMeaning` reinjection).

**Assessment.** The two-tier design is the right call — it is *why* importers got cheap (you never
model the long tail) — but three consequences must be stated plainly:

1. **Known, measured loss:** when a translated verse omits intra-verse markers, footnotes/xrefs in that
   verse are dropped on USFM export; the system counts and surfaces this
   (`X-Usfm-Lossy-Verse-Count`, `usfm-lossless.ts:408-434`). Mixed inline formatting in DOCX collapses
   to the dominant run (`docx.ts:9-35`).
2. **A dropped field:** DOCX/PPTX `sourceLocation` (block path) is parsed but never stored — the
   projection binds every column except it (`event-projection.ts:139-181`) — forcing positional
   paragraph matching at export. Cheap to fix; a real leak today.
3. **The structural limit — narrower than it first looks:** side-car reinjection can only re-emit
   *the format that came in*. For print publishers this is not the blocker it appears to be, because
   the format that comes in (IDML) **is** the print format: a translated IDML re-injected into the
   publisher's own InDesign file is print-ready output in their existing toolchain — no PDF
   typesetting engine on our side. The limit that remains real: producing an output with *no incoming
   skeleton* (e.g. typeset print from a plain-text or USFM-only source) requires typesetting semantics
   the cell model doesn't carry. Today that caps "any format out" only for cross-format rendering, not
   for round-tripping a publisher's own files.

---

## 5. The Agentization Map

Sorting §2's touchpoints into the three buckets, with in-repo evidence for each placement.

**Agent-ready now** (evidence: agents already did it, in this repo, under harness):

- **Importer development (§2 row 2).** Done: May-31 swarm (4 formats/day), SDBH (2026-07-02). What's
  stopping us is *packaging*, not capability: the loop today runs in our dev environment with an
  engineer approving commits, not in the product with a publisher uploading samples.
- **Format analysis/intake (§2 row 1).** The SDBH spec's measured-facts section is exactly the output
  of pointing an agent at sample files for an afternoon.
- **Translation drafting (§2 row 7 content).** Already agent-executed with human gate: the in-product
  agent stages proposals ("Draft 12 cells in MRK 4") that apply through the normal event outbox only on
  human click (`src/components/agent/ProposalCard.tsx:1-27`, `src/lib/agent/apply.ts`). Blocker for
  unattended runs is plumbing: the batch loop lives in a browser tab (§6).

**Agent-ready with harness** (the harness is specified, mostly built, not yet closed-loop):

- **Agent-written importers, publisher-facing.** The anti-cheat harness exists piecewise and is proven:
  (a) round-trip byte-identity or generated loss report (`sdbh-roundtrip-check.ts`,
  `ROUNDTRIP-FIDELITY.md` — generated from tests, so an agent can't hand-wave it); (b) import
  preview-before-commit already in product (`ImportDialog.tsx:611-627`); (c) the audit-trail spine
  verifies what lands as events. The missing piece is the wrapper: *upload samples → agent drafts
  parser against `TranslatableString` + side-car → harness runs import→export→diff → publisher sees the
  fidelity report, not the code.* This is the same verification philosophy the event log applies to
  translation edits, applied to importer output. Spelled out as bet 2 in §8.
- **Review triage (not review judgment).** Staleness detection, decay scoring, rule violations, and
  terminology checks all exist and compute correctly (`stale-source-route.ts:93-105`,
  `decay-engine.ts`) — but terminate in passive badges. An agent that *queues and orders* human review,
  with the existing violations as its evidence, is harness-ready; auto-validation is not proposed.

**Human-required** (and whose human):

- **Per-cell validation sign-off — CUSTOMER.** This is the product: "audit trail that proves it's
  right" is built from human validation gestures pinned to exact event chains
  (`cell.validate` → `cell_validators`). The play is to shrink *what* needs human eyes (only changed
  or flagged cells), never to fake the sign-off. Churn math: this effort must be made small and
  high-leverage, not zero.
- **Cast/voice direction and recorded narration — CUSTOMER.** Taste and performance
  (`AudioRecordingModal.tsx`); TTS already substitutes where the publisher accepts it.
- **Legacy-system migration — OURS.** GitLab-specific scripts (§2 row 3). Margin threat, not churn
  threat; shrinks to zero for greenfield publishers.
- **Open publisher-semantics questions — CUSTOMER, once per format.** e.g. SDBH's CON-layer question
  for Reinier (commit 13a6816a). Irreducible, but bounded and front-loaded.

---

## 6. The Continuous Pipeline Gap

The retention thesis is "content flows in, output flows out, forever." Verdicts from a full audit of
both workers and the client (details cited; the pattern is uniform):

| Loop link | Verdict | Evidence |
|---|---|---|
| Server-initiated anything (precondition) | **ABSENT** | No `[triggers]`/cron in any `wrangler.toml`; no `scheduled()` handler; no webhook route in `auth-worker/src/index.ts:129-202`; every timer in the client is UI-local |
| Change detection at source | **ABSENT in product / EXISTS as engineer script** | Re-import offers only Skip / Import-as-duplicate (`ImportDialog.tsx:74-76`) — no diff/merge. But `scripts/migrate-all.ts` (Jun 1–3) already does change-detected, delta-only, idempotent re-ingest ("re-syncs send only new events… safe to re-run / cron") against the GitLab source — engineer-run, one source type |
| Incremental re-translation | **ABSENT (detection PARTIAL)** | AD-9 staleness pin + SQL detection exist (`stale-source-route.ts:93-105`) but drive only a tooltip badge (`StaleSourceIndicator.tsx:13-16`); nothing re-drafts, and in the normal flow source cells are never re-committed so the trigger barely fires |
| Unattended translation runs | **ABSENT** | Batch loop is sequential, in-tab, dies with the tab (`batch-completion.ts`); the in-product agent never auto-applies by design |
| Automatic review queuing | **ABSENT** | Validation is manual endorsement; the endorsement-propagation loop is an explicit unbuilt TODO (`event-projection.ts:667-670`); decay/health is a badge, queues nothing |
| Automatic re-render of outputs | **ABSENT** | Every export is an onClick (`ExportDialog.tsx:346`); published artifacts go stale silently |
| Audit trail | **EXISTS** | Append-only `events` with author, client+server timestamps, parent chains, deterministic `server_seq` (`schema.sql:249-277`); per-cell audit read route. Caveat: it proves provenance and source-pinning, not review sufficiency |

**Delta to the demo** ("publisher updates a source file; a corrected, audit-trailed output appears with
zero human initiation, pending only review sign-off"): every primitive exists — delta ingest (script),
staleness query (route), batch drafting (client lib), export rendering (client lib), provenance (log).
What's missing is uniform: **a scheduler and a queue, and wiring the five primitives to them.** That is
the substance of bet 1: ~5 engineer-weeks, not a research project. Today's distance from the demo is
7 human-initiated stages; after bet 1 it is 1 (review).

---

## 7. The Publisher #10 Simulation

**Today** (no new engineering), publisher #10 arrives with: a supported format (30 accepted
extensions — subtitles, USFM/Paratext, DOCX/PPTX, spreadsheets, CAT formats), one novel format, a
legacy system, and monthly content updates.

| Step | Today | After §8 bets 1–3 |
|---|---|---|
| Org/teams/projects/AI setup | Day 1, self-serve, ~half a day (ADMIN) | Same, ~half a day |
| Supported-format content in | Day 1, minutes per batch, self-serve | Same |
| Novel format importer | 1–3 engineer-days for XML/zip-class formats (OUR eng directs agent; SDBH precedent) + one clarifying exchange with the publisher. IDML-class: unproven here — estimate holds only if the §8 spike confirms it | ≤1 day, publisher-facing harness: upload samples → agent-drafted importer → machine-generated fidelity report; our engineer approves the report, doesn't write code |
| Legacy-system migration | 2–5 engineer-days of script adaptation (OURS) — the one genuinely services-shaped step | Unchanged by these bets (declines only as fewer publishers arrive with legacy systems; explicitly not solved here) |
| First full translation pass | Attended browser sessions, ~0.5–2 h per 1,000 cells + review hours | Unattended overnight run; humans spend hours only in review |
| **Each monthly content update** | **Human re-runs everything: import (15 min) + translate (attended hours) + review + re-export per file + manual delivery** | **Zero-touch to review-ready: delta ingest → stale cells re-drafted → review queue populated → outputs re-rendered on sign-off. Human time = review of changed cells only** |
| Elapsed to first output | ~1–2 weeks (mostly review throughput) | ~2–4 days |
| Our engineer-days, total onboarding | ~3–8 | **~0–1** (fidelity-report approval; legacy migration extra, if present) |

The "after" column is defensible because no row of it depends on capability we haven't demonstrated:
rows 3 and 5–6 are re-packagings of things already working in this repo (§3 asset 4, §6 primitives),
not bets on model improvement.

## 8. The Bet — sequenced recommendation

Ranked by operational-effort eliminated per engineer-week. Costs assume the current build pattern
(agent-executed, engineer-directed) at this repo's measured velocity.

**Bet 1 — Continuous-loop substrate. 5 engineer-weeks.** Cloudflare cron + queue; wire the five
existing primitives (§6): productize `migrate-all.ts`-style delta ingest as a per-project source
watcher (start: re-upload/API push + the existing source-linking pointer), auto-feed the staleness
query into server-side batch drafting, populate a review queue ordered by decay/violations, re-render
and version exports on sign-off, all stamped through the existing event log. **Eliminates:** rows 6–7
initiation and row 10 re-render from §2's Operational column. **Success criterion:** demo — publisher
pushes a changed source file; a re-drafted, audit-trailed, review-gated output artifact appears with
zero human initiation. Touches per content update: 7 → 1. **Cost-curve effect:** flattens the
*per-update* cost that publisher count multiplies; this is the churn-column killer.

**Bet 2 — Publisher-facing format-onboarding harness, opened with the IDML spike. 3 engineer-weeks,
of which week 0 is the spike.** First, the timeboxed IDML spike (2–5 days): point the agent at a real
publisher IDML with the side-car + keyed-reinjection pattern; success = byte-identity round-trip on
the untranslated file, and a translated-text reinjection that opens clean in InDesign. This retires
the report's single biggest unknown — whether the months-in-codex-editor format lands in the SDBH cost
class — before the harness is generalized. Then wrap the proven loop (sample files → agent-drafted
parser targeting `TranslatableString` + side-car → import→export→diff → machine-generated fidelity
report) behind the existing import wizard, with our engineer approving the report rather than
authoring code. **Eliminates:** §2 rows 1–2 from our payroll, and converts §3's IDML hypothesis into a
measured number. **Success criterion:** IDML spike green, then a novel real-publisher format goes
sample-to-verified-importer in ≤1 day with 0 engineer hours writing parser code; fidelity report
auto-published. **Cost-curve effect:** importer marginal cost ~5% → ~1%, extended to the print class,
and moved off our critical path entirely.

**Bet 3 — Unattended translation runs. 2 engineer-weeks.** Port the sequential batch loop out of the
browser tab into a worker-side job (prerequisite pieces from bet 1's queue). **Eliminates:** attended
hours in §2 row 7. **Success criterion:** a 10,000-cell project drafts overnight with the laptop
closed; per-1,000-cell attended time 0.5–2 h → 0.

**Not yet:** a typesetting/PDF engine of our own (finding §4.3 — for print publishers the deliverable
is their own IDML round-tripped, which bet 2 covers; cross-format typesetting from skeleton-less
sources waits until a contract demands it); CRDT/collaborative merge (the parent-chain rule is holding at current
concurrency); further white-label brands (each is ~a day when sales needs one); finishing the Postgres
port beyond the shim (D1 is not the bottleneck in any table above).

**Final honesty check against the loss function:** (1) Effort lives in §2, hours attached, churn column
flagged. (2) The importer is a compounding asset *within the format classes built here* — measured at
~5% marginal cost, mechanisms cited — while the class that produced the "months" (IDML/print) is
absent from this codebase and gets a funded spike, not a hand-wave; and the *operational loop* is a
repeating cost today, said plainly. (3) The mechanism is §5/§6: agents already write importers under a
byte-identity harness; the continuous loop is wiring, not research. (4) The fund is bets 1–3:
10 engineer-weeks total; onboarding 3–8 engineer-days → ~0–1; per-update human touches 7 → 1.
