# Laned projects with first-class lane IDs — Design (v2)

**Status:** Proposal for discussion · 2026-09-15
**Supersedes / amends:**
- `2026-09-09-eliminate-default-lane-design.md` (v1 — eliminate the implicit `''` default lane by an in-place primary-key rewrite). The *goal* survives; the *mechanism* is replaced.
- `2026-09-10-lane-permissions-and-read-wall-design.md` (AQU-730 — lane permissions keyed on the lane string). Re-keyed onto `lane_id`.

**Decision (made with Ryder, 2026-09-14):** lanes become first-class rows with opaque
**IDs**. Every project is fully "laned" (no implicit/blank default). Lane-level permissions key
on the ID. We are **not** editing history — the replay shim stays.

---

## 0. The one-sentence change, and why it cascades

Today a lane *is its name*: the string `"Spanish"` is simultaneously the display label and the
database identifier — it is part of the **primary key** of `cells` and seven sibling tables
(`cell_validators`, `file_section_progress`, `assignments`, `artifact_bindings`, `scene_briefs`,
`contextual_runs`, `contextual_drafts`), and a value in `project_member_scopes` and the
`project_settings.targetLanes` JSON array. The default lane has no name at all — it is the empty
string `''`, which is *also* the sentinel meaning "not lane-addressable" on source rows.

v2: **a lane becomes a row in a new `lanes` table with an opaque ID.** Per-row tables reference
`lane_id`; the human name and the language become editable attributes on the lane row. This one
move dissolves most of v1's hazards:

| v1 hazard | v2 outcome |
|---|---|
| Backfill is an in-place **PK-column rewrite** on the largest table; a wrong `side` clause is **unrecoverable without PITR** | Backfill is **additive** — add a `lane_id` column, populate it, verify against the untouched original, then cut over. A mistake is "a bug in a new column," re-runnable. |
| **COLLIDE** (default lane shares a language with a named lane) is a blocking PK-merge crisis → quarantine | Two lanes may share a name; they are distinct IDs. COLLIDE becomes a cosmetic "two lanes named Spanish" a human tidies at leisure. |
| Cannot auto-name unknown lanes: a made-up name becomes a **permanent PK value** | Names are mutable labels. Auto-name "Lane 0", prompt for a rename later. Reversible. |
| Hiding a lane's name/existence is leak-prone because the **name is the key** (flows into URLs, ETags, cache keys, tokens, errors) | Access keys on `lane_id`; the name is a withheld attribute. Name-hiding becomes structurally sound. |

---

## 1. The `lanes` table

> There is **no** `lanes` table today. This creates it.

```sql
CREATE TABLE lanes (
    id          TEXT NOT NULL,                 -- opaque, URL-friendly, permanent
    project_id  TEXT NOT NULL,
    name        TEXT NOT NULL,                 -- display label; editable; NOT unique
    lang_code   TEXT,                          -- BCP-47 (es, sw, qu); NULL = unknown/placeholder
    role        TEXT NOT NULL DEFAULT 'target', -- 'source' | 'target'
    legacy_tag  TEXT,                          -- the pre-cutover target_lang value; immutable
    position    INTEGER NOT NULL DEFAULT 0,     -- stable display order
    archived_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, id),
    UNIQUE (project_id, legacy_tag)            -- one lane per pre-cutover tag (incl. '' default)
    -- NO UNIQUE on (project_id, name): duplicate names are allowed by design.
);
```

Design notes, each load-bearing:

- **`id`** — opaque and permanent. Appears in shareable links, so short/URL-friendly beats a raw
  UUID (cosmetic; decide once — open Q1).
- **`name`** — editable label, **deliberately not unique** (see §0; a uniqueness rule would
  re-create the collision crisis we just removed).
- **`lang_code`** — the *machine's* idea of the language, split out from the human name. NULL is
  honest for a placeholder lane and is what language-aware features (TTS voice, spellcheck,
  language-aware AI, billing's distinct-language count) read. Renames never touch it.
- **`role`** — lets the **source** side reference a real lane (`role='source'`) instead of the
  `''` sentinel, so **no row anywhere is ever blank**. The `side` column on `cells` stays (it is
  cheap and self-describing); `role` is the lane-table mirror that makes "one shared source lane
  per project" explicit.
- **`legacy_tag`** — THE mechanism that makes rename-safe replay work (§3). Immutable. The default
  lane's row has `legacy_tag = ''`.

---

## 2. The migration is additive (the big safety win)

For each project, in order, none of it destructive until the final optional cleanup:

1. **Create lane rows.** One `lanes` row per distinct `target_lang` value the project uses today
   (from `cells`/settings), including one for `''` (the default), plus one `role='source'` lane.
   - `legacy_tag` = the old value (`''` for the default).
   - `name` = derived from the project's recorded `target_language` when usable; else a
     placeholder `"Lane 0"`, `"Lane 1"`, … (reversible — see §4).
   - `lang_code` = the recorded language when confidently known, else NULL.
2. **Add `lane_id` columns** (nullable) to the eight per-row tables + a `lane_id` to
   `project_member_scopes` lane rows.
3. **Populate `lane_id`** by joining each row's `(project_id, target_lang, side/role)` to its
   `lanes` row. The original `target_lang` stays put — this is a *new column*, not a rewrite.
   - Source rows (`side='source'`, `target_lang=''`) map to the project's `role='source'` lane.
     This is now a **safe, verifiable** operation, not the v1 unrecoverable one.
4. **Verify** at leisure: every row has a `lane_id`; source rows all point at the source lane;
   counts reconcile against the audit. The untouched `target_lang` is right there to check.
5. **Cut reads over** to `lane_id`; recompute `file_section_progress` from the freshly-keyed
   `cells`.
6. **Enforce**: `lane_id NOT NULL` + a foreign key to `lanes` (validate `NOT VALID` first, then
   `VALIDATE`), so a missing/dangling lane is a loud error, never a silent fork.
7. **(Optional, deferrable indefinitely)** drop the now-redundant `target_lang` string from the
   **high-volume per-row** tables — see §5 on why, and why the language data is NOT lost.

Properties: idempotent (re-run skips already-populated rows), resumable, per-project consistent,
and — because it is additive — reversible up to step 6.

---

## 3. Replay + the resolution ("fallback") chain

We are not editing history, so the event log permanently contains legacy events that name a lane
by **string** (`targetLang: "Spanish"`) or omit it entirely (the default lane). The projection/
replay shim (`laneOfEvent`, already built as behavior-neutral machinery) resolves any event to a
**`lane_id`** by this deterministic chain — this is the "fallback logic":

1. Event carries an explicit **`lane_id`** → use it. *(everything written after cutover)*
2. Else event carries a **name string** → the project lane whose **`legacy_tag`** matches → its
   `id`. *(pre-cutover named lanes)*
3. Else lane is **absent/blank** → the project lane with **`legacy_tag = ''`** (the default). 
4. Else → **no mapping** → throw and flag; never guess.

**Non-negotiable:** this chain must be pure and produce the **identical** answer on the live path
and during replay. Divergence forks a cell into two conflicting rows — the hazard the whole
project exists to prevent.

**Why `legacy_tag`, not `name`:** resolution matches the tag the event *actually carried at
cutover*, which never changes. A later rename edits `name` only, so history keeps resolving
forever. Matching on `name` would silently break every historical event the instant someone
renames a lane — defeating the point of IDs.

This subsumes the `default_lane_migration` table I built under v1: "which lane is blank?" is now
"the lane with `legacy_tag=''`." That table was redundant for resolution and has been **dropped in
this PR** (migration `0091` freed and reassigned to `project_member_lane_roles`). Any per-project
migration audit record we later want will live on the `lanes` rows themselves.

---

## 4. Placeholder names ("Lane 0")

Enabled *because* of IDs (a made-up name is no longer a permanent PK value). Ladder: derive a real
name from the project's recorded target language when usable; only fall back to `"Lane N"` when
that is genuinely blank. On a placeholder lane, prompt any user with permission to rename at the
soonest opportunity. **Editing is not blocked** (per product decision).

Open considerations:
- A placeholder is **not a language** — `lang_code` stays NULL, and language-aware features must
  handle "unknown" gracefully rather than guessing.
- Placeholder names are **user-visible** in switchers, chips, dashboards, links, and **exports**.
  Recommend gating **export/publish** (not editing) on a real name to avoid shipping files labeled
  "Lane 0" (open Q2).

---

## 5. Do we drop `target_lang`? (Answering the "we still want the language!" concern)

The **language is never lost.** After migration the authoritative language lives on the `lanes`
row (`name` + `lang_code`). The per-row `target_lang` *string* on `cells` etc. becomes a
**denormalized duplicate** of what `lane_id → lanes` already tells you — the same language string
copied onto millions of rows, able to drift from the lane row.

So step 7 (dropping it from the **high-volume per-row** tables) is **optional cleanup**, not a
requirement, and can be deferred forever. Two defensible choices:
- **Drop it** — single source of truth, no drift.
- **Keep it as a cached denormalized column** — avoids a join on the hottest read path.

Either way the `lanes` table always retains the language. Recommend deciding on read-performance
grounds after cutover; default to keeping it until a join proves costly.

---

## 6. The Codex importer (`scripts/migrate-daemon/` + `src/lib/migrate/`)

The importer **is in this repo** — we can change it here, no separate access needed. Two concerns:

- **Going forward:** it must create a `lanes` row (with an ID) at project-creation time and write
  cells against that `lane_id`, instead of dropping content into the nameless default lane.
- **Already-imported projects:** treated as ordinary existing projects by the additive backfill.
  The real risk is **timing** — if the importer keeps minting blank-default projects during the
  migration it creates work behind us — so the importer change lands **before/with** cutover and
  the backfill stays re-runnable.

**Provenance:** there is no first-class "origin=Codex" column on `projects`. Migrated **events are
authored `'legacy-import'`**, and the daemon keeps its own gitlab↔aquilla id map. The audit now
reports `legacy_import_event_count` per project as a heuristic. Consider adding a real provenance
marker (open Q3) if we want a clean, first-class signal.

---

## 7. Lane-level permissions (AQU-730), re-keyed

`project_member_lane_roles` and the read/write walls key on **`lane_id`** instead of the name.
Benefit: the sensitive datum (the language name) no longer rides inside tokens, URLs, cache keys,
ETags, or error strings, so hiding a lane's name/existence is structurally sound rather than a
scrub-everything exercise. The table I created this session is **empty and unreferenced**, so the
name→`lane_id` switch is a trivial edit.

---

## 8. What already-committed work becomes

| Committed this effort | Fate under v2 |
|---|---|
| Slice 0 characterization tests (`04fa5aff4`) | **Keep** — pin pre-migration behavior |
| `laneOfEvent` shim machinery (`f1e7951fa`) | **Keep + generalize** — same seam; now resolves to `lane_id` via the §3 chain |
| Registry completeness (`ab4744628`) | **Stepping stone** — JSON `targetLanes` is eventually superseded by `lanes`, but it removed the blocking validator and established "the primary is a real lane" |
| `default_lane_migration` table (`c2eb11ff2`) | **Dropped in this PR** — superseded by `legacy_tag`; migration `0091` reused for `project_member_lane_roles` |
| `project_member_lane_roles` (AQU-730) | **Re-key** name → `lane_id` (empty table, trivial) |

---

## 9. Open questions

1. **Lane ID format** — short opaque slug vs. UUID (they appear in links).
2. **Export/publish gating** on placeholder-named lanes — block, warn, or allow?
3. **First-class Codex provenance marker** on `projects` — add one, or keep the `legacy-import`
   heuristic?
4. **Name/`lang_code` UX** — keep "lane named by its language" in the UI for now (many users are
   attached to it) while storing `lang_code` separately? Storage is additive and easy to defer;
   this is purely a UX decision and can change later at low cost.
5. **Drop vs. keep `target_lang`** on hot tables (§5) — decide post-cutover on perf grounds.
6. **Who may name a placeholder lane** — any project lead, or narrower?
7. **`chain_claims`** — v1's straddle test passed (Option A). Confirm the same holds when the key
   derives from `lane_id`; expected yes since resolution is deterministic.

---

## 10. Sequenced plan (delta from v1)

1. Audit (read-only, prod) — now reports org rollup, distinct-lane-value counts, and the
   `legacy-import` signal. **Run first.**
2. `lanes` table + create lane rows per project (additive).
3. Add + populate `lane_id` columns (additive; source rows → source lane).
4. Generalize the shim to resolve to `lane_id` via the §3 chain (keyed on `legacy_tag`).
5. Importer: create lane rows + write `lane_id` at import time.
6. Cut reads to `lane_id`; recompute progress.
7. Enforce `NOT NULL` + FK.
8. Re-key permissions and the read/write walls to `lane_id`.
9. Forced-choice UX + placeholder-rename prompts.
10. (Optional) drop redundant `target_lang` from hot tables.

**Non-negotiables:** the §3 resolution chain is identical live vs. replay; the importer change
lands before/with cutover; the backfill is additive and re-runnable; no uniqueness on lane names.
