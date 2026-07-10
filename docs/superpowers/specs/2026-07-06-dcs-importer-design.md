# DCS (Door43 Content Service) Importer — External Upstream Adapter — Design

**Status:** Approved for build (autonomous swarm) · 2026-07-06
**Driver:** unfoldingWord / Gateway-Language teams translate the whole Door43 resource
stack (Bible, OBS, Translation Notes/Questions/Words/Academy) out of English into hundreds of
languages. They need to (a) pull any Door43 resource into Aquilla as translatable content and
(b) find out when the English upstream was corrected and pull just the delta.
**Builds on:** `2026-07-06-linked-projects-provenance-invalidation-design.md` — specifically
its **§11 "External upstreams: the unfoldingWord pattern"**. This spec *is* Slice 6 of that
design. The linked-projects invalidation engine (mirror + pin + derive-on-read staleness +
review panel) is assumed shipped (FRO-476/477/478/479) and is **reused unchanged**.

---

## 1. The one-sentence design

A Door43 repo is represented as an ordinary Aquilla **upstream project** ("adapter project")
whose source lane is written by a **DCS→events adapter**; once it exists, every existing
linked-projects capability — linking, mirror sync, cell-lineage staleness, chains, bulk review
— applies with **zero new invalidation code**. All we build is the adapter, a catalog browser,
and the two import affordances (as source / as aligned target).

Everything about Door43 that looks special turns out to reduce to two facts:

1. **Every Door43 resource is content someone translates.** unfoldingWord authors the notes,
   questions, dictionary, and manual in English; Gateway-Language teams translate them the same
   way they translate scripture. So there is no "reference/helps sidebar" problem — every
   resource type imports as ordinary **source cells** (to translate from) or pre-fills a
   **target lane** (from an existing translation). It renders in the normal editor.
2. **Door43 is a Gitea host with a released-version Catalog on top.** "Is my import stale?" is
   one HTTP request; "what changed?" is a `compare` request. So invalidation is **pull-based
   and manual** — no webhooks, no background infra.

---

## 2. What is inherited for free (do NOT rebuild)

| Capability | Where it already lives | DCS reuse |
| --- | --- | --- |
| One-upstream-per-project link + cycle guard | `projects.source_project_id`, `auth-worker/src/routes/source-linking.ts` | DCS adapter project is the upstream; language projects link to it |
| Mirror sync (advance downstream source to upstream head) | `sync-worker/src/events/link-sync.ts` | unchanged — fires when a downstream opens |
| Per-cell provenance + monotonic apply | `cells.upstream_event_id/upstream_seq/content_hash` | the adapter's `source.cell.*` events carry it |
| Derive-on-read staleness (direct + inherited/chain) | `stale-source-route.ts`, `useStaleSourceCells.ts`, `StaleSourceIndicator.tsx` | a DCS delta moves adapter source heads → downstream targets flag stale, identically to an internal upstream |
| Bulk "Upstream changes" review + repin | `UpstreamChangesPanel.tsx`, `useUpstreamChangesReview.ts`, `target.cell.repin` | unchanged — Anna's review surface works over a DCS-fed upstream |
| Clone vs live, consumes source/target, chains | linked-projects §2 | "import as source" = link consumes:source; "aligned target" = §9 |

**Consequence:** the DCS work is a *content producer* for an existing consumer. If the adapter
correctly writes `source.cell.create/commit/delete` with stable ids + content hashes into an
adapter project, invalidation, chains, and review all light up with no further work.

---

## 3. The uniform pipeline

```
DCS Catalog browse  → pick a resource (repo@ref)
  → adapter fetches content (raw files or zipball) at the pinned ref
  → format parser → TranslatableString[]  (existing parser shapes)
  → map each unit to a DETERMINISTIC cell-id  (§5)  + content_hash
  → emit source.cell.create/commit (+ file.create) via the existing import path
       into the ADAPTER PROJECT's source lane
       │
       ├─ IMPORT AS SOURCE:  language project LINKS to the adapter project (consumes:'source')
       │                     → translates fresh; adapter deltas flag it stale
       └─ IMPORT AS ALIGNED TARGET (§9): pre-fill the language project's TARGET lane from an
                                 existing DCS translation, matched by ref — snapshot or live
```

The only per-resource-type variation is **the parser** and **the cell-id rule**. Everything
downstream (events, linking, invalidation, review) is uniform.

---

## 4. Resource types → parser → translatable unit → cell identity

Routed by the RC manifest's `dublin_core.type` (`book`/`help`/`dict`/`man`/`bundle`) and the
catalog entry's `subject`/`content_format` — never by hardcoding repo names.

| Resource (subject) | Format | Translatable unit → cell | Cell-id seed (→ `uuidv5`) | Parser status |
| --- | --- | --- | --- | --- |
| Bible ULT/UST, UGNT, UHB (`Bible`, `Aligned Bible`, `Greek/Hebrew …`) | USFM3 | one **verse** | `repo \| BOOK C:V` (from `globalReferences`) | ✅ `usfm.ts` |
| Open Bible Stories (`Open Bible Stories`) | Markdown | one **story frame** | `repo \| OBS story:frame` (from `group`) | ✅ `obs.ts` |
| Translation/Study Notes (`TSV Translation Notes`, `TSV OBS …`, `sn`) | TSV | the **`Note`** prose (one row) | `repo \| book \| rowID` (TSV `ID` col — stable by design) | ⚠️ extend `translation-notes.ts` |
| Translation/Study Questions (`TSV Translation Questions`, `TSV OBS …`, `sq`) | TSV | **`Question` (+`Response`)** (one row) | `repo \| book \| rowID` | 🟢 new TSV variant |
| Translation Words (`Translation Words`) | Markdown dict (1 file/term) | article, split by heading/¶ block | `repo \| termPath \| blockIdx` | 🟢 new markdown-block parser |
| Translation Academy (`Translation Academy`) | Markdown manual (modules) | article, split by heading/¶ block | `repo \| modulePath \| blockIdx` | 🟢 new markdown-block parser |
| Translation Words **Links** (`TSV … Words Links`) | TSV join table | — mostly structural (orig-word → `rc://` link), little prose | **deferred** (import as alignment metadata later) | ⏸️ out of v1 |

Non-translated TSV columns (`SupportReference`, `Quote`, `Occurrence`, `Tags`) ride in
`cells.metadata` (already a JSONB bucket threaded through `BulkImportCell.metadata`). tW/tA
markdown is the only **id-unstable** case (no ID column); content-hash matching in the mirror
engine absorbs paragraph reflow, and structural edits map to explicit `cell.delete` +
`source.cell.create` (§5). v1 splits markdown at top-level headings/blank-line blocks.

---

## 5. Cell-identity contract (the hard requirement, §11.1)

Parser-default fresh UUIDs (`uuidv7`) break cross-import lineage — re-importing a repo would
mint all-new ids and orphan every downstream translation. The adapter therefore **overrides the
parser's ids** with content-addressed ones:

```ts
// src/lib/dcs/cell-id.ts — mirrors src/lib/migrate/ids.ts's u5() pattern
import { v5 as uuidv5 } from "uuid"
const DCS_NS = "…fixed namespace UUID…"           // one constant, never changes
export const dcsCellId = (seed: string) => uuidv5(seed, DCS_NS)
// seeds per §4, e.g. dcsCellId(`unfoldingWord/en_ult|TIT 1:1`)
```

Rules:

- **Stable across releases.** The seed depends only on repo + reference/rowID/path, never on a
  commit SHA or import time. v87 and v89 of `en_ult` produce the *same* id for `TIT 1:1`, so a
  delta is a `source.cell.commit` on an existing cell, not a create.
- **Re-segmentation ⇒ delete + create.** A verse bridge (`1:1-2`) or a moved manual article
  changes the seed → new id; the old id's content vanishes from the parse → adapter emits
  `cell.delete` (tombstone) for it. Never id-churn on unchanged content.
- **Deterministic event ids too.** `eventId = uuidv5(`${repo}|${sha}|${cellId}`, DCS_NS)` so a
  re-run of the same delta dedupes via the existing events-PK idempotency path.
- **File ids** likewise deterministic: `dcsCellId(`${repo}|file|${bookOrPath}`)`.

---

## 6. Freshness & delta — verified against the live API (2026-07-06)

All endpoints below were confirmed live; DCS sends `access-control-allow-origin: *`, so the
adapter runs **client-side** (no proxy).

**"Am I out of date?" — one request.** Store the pinned release at import time. To check:

```
GET /api/v1/catalog/entry/{owner}/{repo}/{ref}
→ { subject, content_format, branch_or_tag_name, commit_sha, released, zipball_url }
```

Compare stored `commit_sha`/tag vs. the current prod release. (Backups if ever needed: repo
`updated_at`, `commits?limit=1` sha+date, per-file `commits?path=…` date.)

**"What changed?" — the delta.** Confirmed working:

```
GET /api/v1/repos/{owner}/{repo}/compare/{oldRef}...{newRef}
→ { total_commits, commits:[ { files:[ {filename} ] } ] }
```

⚠️ **Gitea-version quirk:** DCS does **not** populate the response's top-level `.files`; the
changed-file set is the **union of `.commits[].files[].filename`**. The adapter must read it
there (verified: `en_ult` v88→v89 = 55 files via the per-commit union).

**Two-level delta:**
1. `compare` → changed **files** (books/stories/note-files).
2. Re-fetch + re-parse only those files → **content-hash** each cell → emit
   `source.cell.commit` only for hash-changed cells, `source.cell.create` for new ids,
   `cell.delete` for vanished ids. Unchanged cells emit nothing.
3. **Full-scan reconcile** (parse every file, hash-compare) is always available as the
   self-heal path — same philosophy as linked-projects §5.

**Cursor = prod release tag/SHA.** Track the published **release** (`stage=prod`, e.g. `v89`),
not raw `master` HEAD — HEAD carries unreviewed WIP (today's `en_ult` master already has
in-progress edits past v89). A per-import toggle offers "track latest release" (default) vs.
"track HEAD" (bleeding edge).

**Triggers are pull-only and manual** (this is the deliberate simplification vs. linked-projects
§8): no webhooks, no queues. The whole story is two buttons — "Check for updates" (one catalog
request) and "Import changes" (run the delta). Linked-projects' push accelerator is explicitly
*not* built for DCS; the design already declares push non-load-bearing.

---

## 7. Adapter execution model

**v1: client-side importer**, in the SPA, reusing the existing import pipeline — the same shape
as today's OBS/eBible imports (browser fetches door43, parses, emits events). New module tree:

```
src/lib/dcs/
  catalog.ts      # typed DCS Catalog + Gitea client (search, entry, compare, tree, raw)
  cell-id.ts      # deterministic uuidv5 seeds (§5)
  manifest.ts     # RC manifest.yaml parse → { type, subject, format, projects[] }
  resource-map.ts # subject/type → parser + cell-id rule dispatch (§4)
  import-dcs.ts   # orchestrates: fetch@ref → parse → id-map → emit (via existing bulk import)
  delta.ts        # compare → changed files → re-parse → hash-diff → emit commit/create/delete
  cursor.ts       # read/write dcsUpstream cursor on the adapter project (§8)
```

Emit through the **existing front door** (`emitParsedFile` / `bulkUploadSource` →
`POST /import`), not raw inserts — same rule as the translation agent and §11.3. The adapter
post-processes parser output to (a) replace ids with `dcsCellId(...)` and (b) stamp
`content_hash`; everything else in the import path is unchanged.

**Future (not v1):** a server-side service-account adapter (worker + cron) for orgs that want
hands-off syncing. The client-side path proves the whole thesis and matches existing patterns;
server automation is a hardening follow-up.

---

## 8. Data model

**No schema migration for v1.** The DCS cursor lives in the adapter project's
`project_settings` under a new key (JSONB), mirroring how other per-project config is stored:

```jsonc
// project_settings key: "dcsUpstream"
{
  "owner": "unfoldingWord",
  "repo": "en_ult",
  "subject": "Aligned Bible",
  "contentFormat": "usfm",
  "trackMode": "release",          // "release" | "head"
  "ref": "v89",                     // the pinned release tag (or branch)
  "commitSha": "84c73ba0…",         // cursor
  "released": "2026-06-23T22:01:02Z",
  "importedAt": "2026-07-06T…Z"
}
```

Reuses linked-projects columns as-is: `source_project_id`, `source_link_mode`,
`source_link_consumes`, `cells.upstream_event_id/upstream_seq/content_hash`. The adapter
project is an ordinary project; its "external upstream" identity is entirely the `dcsUpstream`
setting. (A first-class `external_upstream` column is a future normalization if multiple
external origins land; not needed now.)

---

## 9. Import UX

One new **"Door43 / DCS" source** in the existing `ImportDialog` screen dispatch (alongside
Upload, eBible, OBS, …):

1. **Catalog browser.** Filter by language / subject / owner / stage against
   `/api/v1/catalog/search`; list results with manifest-derived type + release date; pick one.
2. **Choose role:**
   - **Import as source** → creates (or reuses) the **adapter project** for that repo@ref in
     the current org, runs the import, and links the *current/new* language project to it
     (`consumes:'source'`, mode `live` default so deltas propagate; `clone` offered for a
     frozen snapshot).
   - **Import as aligned target** → the language project's **target** lane is pre-filled from a
     DCS *translation* of the resource, matched to existing source cells by canonical ref
     (generalizes `prepareEBibleTargetImport`). Sub-choice, per import:
     - **Snapshot** — one-time `target.cell.commit` pre-fill; then independent/editable.
     - **Live** — a `consumes:'target'` link; the DCS translation stays subscribed and its
       changes flag the target stale (mirror-locked lane, chain semantics).
3. **Freshness affordances** on any DCS-linked project (settings section): "Check for updates"
   → shows `v88 → v89, N files changed`; "Import changes" → runs the §6 delta.

The **catalog browser** and the **freshness/delta panel** are the only substantial new UI;
import-as-source reuses the linked-projects create flow, and aligned-target reuses the eBible
target-import matching UI.

---

## 10. Adapter-project hosting (v1 decision)

**v1: the adapter project is created in the importing user's current org** — same-org linking,
untouched. This keeps the overnight build inside today's permission model (the create-dialog
upstream picker is same-org) and is sufficient for the pilot and the dev proof.

**Deferred:** a shared **"Door43 mirror" system org** with cross-org, public-read adapter
projects (so 600 teams share one `en_ult` mirror instead of each holding a copy). That needs a
cross-org linking carve-out and is a follow-up once the single-org path is proven. Noted as the
top future decision.

---

## 11. Permissions

- Importing / creating an adapter project & linking: **project_lead (500)** on the downstream —
  as linking already requires today.
- Running a DCS delta into an adapter project: the importing user is **maintainer (600)** of
  the adapter project they created (client-side emit under their own token).
- Reading stale flags / freshness: **viewer (100)**.
- No new cross-project or cross-org grant in v1 (see §10).

---

## 12. Scope boundaries

**In v1:** catalog browse; import-as-source and import-as-aligned-target (snapshot + live) for
**Bible (USFM)** and **OBS (Markdown)**; extend to **TSV notes/questions (tn/tq/sn/sq)** and
**markdown tw/ta** as the parser slices land; per-resource freshness check + manual delta
import; the whole thing riding the existing linked-projects invalidation/review engine.

**Out of v1 (explicit non-goals):** webhooks / background sync (pull-only by design); `twl`
join tables; `rc://` link-graph resolution and any tw/ta *reader* UI (tw/ta are translated as
plain documents in the editor); USFM `\zaln` word-alignment layer; shared cross-org mirror org
(§10); server-side service-account adapter (§7); multi-upstream projects (linked-projects
non-goal).

---

## 13. Rollout slices (build order for the swarm)

Vertical proof first, then breadth.

1. **Slice A — DCS client + USFM adapter + cursor (the thesis).** `catalog.ts`, `manifest.ts`,
   `cell-id.ts`, `resource-map.ts` (USFM route), `import-dcs.ts`, `delta.ts`, `cursor.ts`.
   Import `en_ult` (or a single book) at a **pinned old release** as an adapter project;
   emit deterministic-id source cells. Unit-tested end to end. **No UI yet** (drive via a thin
   dev entry / test harness).
2. **Slice B — Import UX.** Catalog browser + "Import as source" wired into `ImportDialog` and
   the linked-projects create flow; freshness "Check for updates" + "Import changes" panel.
3. **Slice C — Delta invalidation proof.** Wire the delta so re-pinning the adapter from the old
   release to a **newer real DCS release** moves source heads and flags linked downstream
   targets stale (reusing `stale-source` + `UpstreamChangesPanel`). This is the money slice.
4. **Slice D — Aligned target.** Snapshot + live target import (generalize
   `prepareEBibleTargetImport`; live = `consumes:'target'`).
5. **Slice E — More resource types.** OBS (parser exists), then TSV tn/tq/sn/sq (extend
   `translation-notes.ts`), then markdown tw/ta (new block parser). Each is one parser + one
   cell-id rule; the pipeline is unchanged.

Slices A + C are the **must-hit** for "prove it end to end." B makes it usable; D/E broaden.

---

## 14. Dev proof plan (the overnight deliverable)

Prove the thesis with **real DCS data and real version history** — no simulation:

1. Pick a small resource with a clean recent change between two prod releases (e.g. a single
   book of `en_ult`, or `en_tn` for one book). Identify two release tags `vOLD` < `vNEW` where
   that file changed (via `compare`).
2. **Import at `vOLD`** as an adapter project in a dev org.
3. **Create two language projects** (e.g. "French — Titus", "Spanish — Titus") linked to the
   adapter project (`consumes:'source'`, live). Confirm both show the `vOLD` source verses.
4. Translate a couple of the soon-to-change cells in each, so there's target content to
   invalidate.
5. **"Check for updates"** → shows `vOLD → vNEW`, N files changed. **"Import changes"** → runs
   the delta into the adapter project.
6. **Observe end to end:** the changed source cells' targets flag **stale** in both language
   projects; the **Upstream changes** panel lists them with old→new diff; **repin** or
   **re-translate** resolves them. Capture with the browser-driving QA agent (screenshots +
   asserted server state after reload — the real gate per project QA convention).

Success = steps 3, 5, 6 demonstrably work in the dev stack against live git.door43.org.

---

## 15. Open questions / risks

- **tW/tA cell granularity & id stability** (§4/§5): block-splitting markdown without an ID
  column will churn ids on structural edits; content-hash matching mitigates but review may
  show spurious deletes+creates. Acceptable for v1 (tw/ta are Slice E, lowest priority).
- **Adapter-project dedupe within an org:** if two users import `en_ult`, do they share one
  adapter project or make two? v1: reuse by `(owner/repo)` match on `dcsUpstream`; flag if
  found. Cross-org sharing is §10-deferred.
- **Aligned-target ref matching for non-verse resources:** eBible matching is verse-keyed;
  TSV/markdown aligned-target needs the same rowID/path identity as §5 (fine), OBS needs
  story:frame. Verify the match key per type in Slice D/E.
- **Large-repo import cost:** a full Bible is ~66 files / ~31k verses; the existing 1500-cell
  chunked bulk upload handles it, but the dev proof should use a single book to stay fast.
- **HEAD vs release cursor** default confirmed as **release**; revisit if a partner wants
  bleeding-edge.
