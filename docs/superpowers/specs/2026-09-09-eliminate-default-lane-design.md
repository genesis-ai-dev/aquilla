# Eliminating the implicit `''` default lane — inventory, migration, and forced-choice UX — Design

**Status:** Proposal for discussion · 2026-09-09
**Scope:** design, inventory, and migration planning only. No application source and no migration
SQL was written producing this document.
**Branch context:** `Luke-Lane-Updates`, on top of the `ProjectCreateDialog` multi-lane overhaul.
**Builds on / collides with:** `2026-07-11-project-data-model-decision.md` (AQU-538, the spec that
*introduced* `''`), `2026-07-14-pm-lane-oversight-design.md`, `2026-09-09-lane-read-wall-design.md`
(in flight — reconciled in §6), migrations 0057–0062, `rollout/aqu538-*.sql`.

**Product decision being designed to (not re-litigated):**

1. There is no default lane. The implicit `''` lane is eliminated as a concept.
2. Anything that can be done with a lane forces an explicit lane choice. No silent defaulting,
   no falling back to a persisted or implicit lane.
3. This holds at N=1. A Self Contained single-target project presents the same explicit choice
   with exactly one option. The AQU-538 "N=1 is always `''`, no switcher, byte-identical"
   optimization is retired.

---

## 0. The finding that reshapes the whole task

`''` is **two different concepts wearing one value**, and only one of them can be eliminated.

In `cells`, the primary key is `(project_id, file_id, cell_id, side, target_lang)`. For
`side = 'target'`, `''` means *the default lane*. For `side = 'source'`, `''` means *not
lane-addressable* — migration 0057 states it outright: *"Source-side rows are ALWAYS `''` — the
source exists once, shared by lanes."* There are 33 SQL sites across 21 non-test files carrying a
literal `target_lang = ''` or `DEFAULT ''`, and a large fraction of them are
`side = 'source' AND target_lang = ''` — the shared-source read, not the default-lane read
(`event-projection.ts:566,609`, `import-reconcile-route.ts:570,618,720`,
`auth-worker/routes/contextual.ts:779`, `lib/contextual/tick.ts:619`,
`lib/contextual/activity-labels.ts:118`, `db/shared/contextual-runs.ts:1906`,
`migrate-cell-ids-route.ts:53`).

So the deliverable is **not** "replace `''` everywhere." It is:

> Make `''` **illegal for `side = 'target'`** and leave it as the source side's
> not-lane-addressable sentinel.

This reframing matters for three reasons:

- It makes the invariant **machine-enforceable**, which is the only way a change this diffuse
  actually holds. A single `CHECK (side <> 'target' OR target_lang <> '')` on `cells` is worth
  more than every code review in the plan. Same for `assignments`, `cell_validators`,
  `file_section_progress`, `contextual_runs`, `contextual_drafts`, `scene_briefs`,
  `artifact_import_bindings`, and `project_member_scopes` rows with `kind = 'lane'` (all of which
  are target-only and can take a flat `target_lang <> ''`).
- It shrinks the blast radius roughly in half versus a naive "eliminate `''`" reading.
- It tells you which of the 63 falsy-`''` JavaScript sites are actually dangerous: the ones on
  the target path. A `?? ''` that only ever feeds a source-row predicate is inert.

The second structural finding, developed in §3, is that the event log and the `chain_claims`
table both encode the `''` convention in **persisted, immutable, replay-load-bearing** form.
That is the real risk in this project, not the UI.

---

## 1. Complete inventory

Counts are from mechanical scans of the non-test, non-`dist` tree:

| Category | Occurrences | Files |
|---|---|---|
| A. SQL literal `target_lang = ''` / `DEFAULT ''` | 33 | 21 |
| B. JS coercion of a lane to `''` (`?? ''`, `\|\| ''`) | 85 | — |
| C. **Falsy-`''` truthiness gates** (`lane ? …`, `if (!lane)`, `…(lane ? {} : {})`, `lane \|\|`) | **63** | 32 |
| D. `?lane=` / `?targetLang=` param defaulting to `''` | 9 | — |

**~181 machine-detected sites, of which 63 are the silent-breakage class.** B and C overlap
slightly; the tables below enumerate the load-bearing subset by hand. Categories B and C are the
ones that will not fail loudly: an `''` that survives a rename simply stops matching and a pane
renders empty.

### 1.1 Postgres schema and migrations

| File · line | Assumes | Must become |
|---|---|---|
| `db/postgres/schema.sql:536` `cells.target_lang TEXT NOT NULL DEFAULT ''` | `''` valid for both sides | Keep the column and the default (source needs it). Add `CHECK (side <> 'target' OR target_lang <> '')`. **Drop the `DEFAULT ''`?** No — dropping it breaks every source-row insert. Keep it; the CHECK is the guard. |
| `schema.sql:539` PK `(project_id, file_id, cell_id, side, target_lang)` | unchanged | unchanged — but see §2.5, the backfill is a **PK-column UPDATE**, i.e. a row-identity change, not a value change |
| `schema.sql:552,567` `file_section_progress` | target-only, PK carries `target_lang` | flat `CHECK (target_lang <> '')`. Confirmed target-only: `progress-projection.ts:106-129,237-263` derives lanes from `SELECT DISTINCT target_lang … WHERE side='target'` |
| `schema.sql:608,612` `cell_validators` | target-only | flat `CHECK (target_lang <> '')` |
| `schema.sql:768` + `migrations/0060_assignments_target_lang.sql:24` `assignments.target_lang TEXT NOT NULL DEFAULT ''` | `''` = default lane, *"every pre-lane assignment"* | flat `CHECK (target_lang <> '')`; **drop the `DEFAULT ''`** so a caller that forgets the lane gets a `NOT NULL` violation instead of a silent default lane. This is the single highest-value schema edit in the plan |
| `schema.sql:851` `idx_cells_file_scan` | includes `target_lang` | unchanged |
| `schema.sql:1132,1142` `artifact_import_bindings` | `''` default lane | `CHECK (target_lang <> '')` (verify no source-role bindings use `''` first) |
| `schema.sql:1311,1329` `scene_briefs` | `''` default lane | `CHECK (target_lang <> '')` |
| `schema.sql:1379` `contextual_runs` — comment says *"`''` = the file's single target language"* | `''` default lane | `CHECK`; comment rewritten |
| `schema.sql:1436` `contextual_drafts` — *"`''` = project default"* | `''` default lane | `CHECK`; comment rewritten |
| `schema.sql:1006-1021` `project_member_scopes` — comment: *"default lane stored as literal `''`"* | `''` is a legal scope value | `CHECK (kind <> 'lane' OR value <> '')`; the `PUT` route's zod `z.string()` gains `.min(1)` |
| `schema.sql:258` / `migrations/0054` `target_language` generated column | the default lane's language, distinct from `targetLanes` | Becomes the *source of the backfill tag* and then a lane like any other. Do **not** drop it — org-portfolio (`org-permissions.ts:948`) reads it, and dropping generated columns from a multi-MB settings blob is a separate project |
| `migrations/0057,0058,0060` header comments | document `''` as "the legacy/default lane" | Historical; add a pointer to the new migration rather than editing shipped migrations |
| `rollout/aqu538-00-expand.sql:20-26`, `aqu538-99-contract.sql` | `DEFAULT ''` on four tables | Historical; leave |
| `migrations/0075:27-35` backfills `contextual_drafts.target_lang` from the owning run | precedent for the "inherit the owner's lane" pattern | Reuse the shape in the new migration |

Tables carrying `target_lang`, complete: **`cells`, `cell_validators`, `file_section_progress`,
`assignments`, `artifact_import_bindings`, `scene_briefs`, `contextual_runs`,
`contextual_drafts`**, plus `project_member_scopes.value` where `kind = 'lane'`.

Tables that carry a lane **only inside JSON** and therefore cannot be constrained:
**`events.payload.targetLang`** (the critical one — §3), `chain_claims.parent_key` (the lane is
embedded in a composed string — also §3).

Tables that are lane-bearing in the read-wall spec's inventory but have **no** lane column and so
need nothing here: `cell_audio`, `cell_backtranslations`, `cell_waivers`, `cell_links`,
`plan_units` (explicitly not lane-keyed by design), `file_segmentation` (migration 0079: *"NO
`target_lang`: every language lane of a file reads the same segmentation"*).

### 1.2 sync-worker

| File · line | Assumes | Must become |
|---|---|---|
| **`events/event-projection.ts:145-149` `laneOfEvent(kind, payload)`** | `targetLang` absent or non-string ⇒ `''` | **The single most important function in this project.** Must take a resolved project default lane and map absent/`''` ⇒ that tag for target kinds. See §3.2 |
| **`events/chain-claims.ts:64` `laneQualifiedParentKey`** — `targetLang ? \`${base}@lane:${targetLang}\` : base` | default lane keeps the **unqualified legacy key** | §3.3. Recommendation: **do not change this.** It must keep deriving from the raw payload |
| **`events/chain-claims.ts:99` `qualifyParentKeyBase`** — `typeof lang === 'string' && lang ? …` | same | same — leave raw |
| `events/handlers/assignment-events.ts:81` `p.targetLang ?? ''` | absent payload ⇒ default lane | reject the event (400) when `targetLang` is absent or empty on `assignment.create` |
| `events/cells-read-route.ts:601` `const laneFilter = qLane && qLane.length > 0 ? qLane : null` | present-and-empty ⇒ all lanes | becomes correct by construction (`''` is no longer a lane), but must become **`lane` required** (400 when absent) to satisfy rule 2 |
| `events/cells-read-route.ts:172` `row.target_lang ?? ""` | coercion | drop the coercion; column is NOT NULL |
| `events/cells-read-route.ts:390` chainCache key `${laneFilter ?? ""}` | `''` and `null` collide in the cache key | must not collide — see read-wall §4.5, this is a cross-user leak |
| `events/progress-read-route.ts:168` `url.searchParams.get('lane') ?? ''` | absent ⇒ default lane | 400 on absent |
| `events/progress-read-route.ts:213,281` `lane ? ':lane:'+lane : ''` (ETag) | default lane has no ETag suffix | always suffix; otherwise the pre- and post-migration ETags for the same data collide and clients serve stale `304`s **through the migration** |
| `events/export-route.ts:58` `?? ""` | absent ⇒ export the default lane | 400 on absent. Exporting the wrong language silently is the worst-consequence instance of implicit defaulting in the app |
| `events/export-bundle-route.ts:53` `?? ""` | same | 400 |
| `events/health-rollup-route.ts:200` `targetLang: url.searchParams.get("lane") ?? ""` | same | 400 |
| `events/cell-confidence-route.ts:122` `?? ""` | same | 400 |
| `events/branching-search-route.ts:131`, `branching-search-passages-route.ts:104` `?? ""` | same | 400 |
| `events/plan-route.ts:162` `(get('lane') ?? '').trim()` | same | 400 |
| `events/files-read-route.ts:241` `… AND p.target_lang = ''` (hardcoded join) | file listing joins default-lane progress | must take the caller's chosen lane; already flagged as read-wall path #22 |
| **`events/link-sync.ts:381` `payload.targetLang !== ''`** — *"v1 target-consumption links consume the upstream's DEFAULT lane only"* | the donor lane is `''` | **must resolve through the upstream's migrated tag or every chain link silently stops syncing.** Top-3 risk |
| `events/link-sync.ts:440` `side='target' AND target_lang = ''` | same | same |
| `events/merge-sibling-route.ts:104` `side='target' AND target_lang = ''` (donor read) | donor is the default lane | resolve to the donor's tag |
| `events/merge-sibling-route.ts:258-260` `if (!lane) → 400` | host lane must be non-empty | already correct; a rare pre-existing example of the target behaviour |
| `events/import-reconcile-route.ts:550,594,843,959` `?? ''` | absent ⇒ default lane | resolve |
| `events/import-reconcile-route.ts:861` `...(targetLang ? { targetLang } : {})` | omit-on-wire | always emit |
| `events/source-upload-route.ts:150-161,418` `targetLang` defaults `''`; `bindingRole !== 'target' && targetLang.length > 0` rejects | source bindings must be `''` | keep for source; require non-empty for `bindingRole === 'target'` |
| `events/import-route.ts:658` `...(target.targetLang ? { targetLang } : {})` | omit-on-wire | always emit |
| `events/validators-read-route.ts:79` `r.target_lang ?? ''` | coercion | drop |
| `events/rebuild.ts:124` replay childKey via `laneOfEvent` | `''` for legacy | inherits §3.2 |
| `events/authorize.ts:79-81` `if (laneScopes.length > 0) … !laneScopes.includes(lane)` | `lane` from `laneOfEvent`; `''` is a legal scope | inherits §3.2; `''` scope becomes illegal |
| `external/emit-events-engine.ts:137,211,220,355,361,390,393` `e.laneId ? … : …` (7 sites) | `laneId` falsy ⇒ default lane; error copy literally says *"the default lane"* | `laneId` required on every lane-bearing command |
| `external/commands.ts:171` `c.laneId !== undefined && (!isNonEmptyString(c.laneId) …)` | `laneId` optional | required |
| `external/commit.ts:396,405,418,638` `laneCellKey(…, p.laneId)`, `...(cmd.laneId ? …)` | omit-on-wire | always |
| `external/prepare.ts:236,290,309,419,430` — incl. `variant.laneId \|\| cmd.targetLanguage \|\| ''` | triple fallback ending in `''` | explicit lane required; the `targetLanguage` fallback is exactly the implicit defaulting rule 2 bans |
| `external/cell-keys.ts:17` `laneId ?? ''` | coercion | required arg |
| `external/preconditions.ts:64,100` `c.laneId ?? ''`, `(r.target_lang ?? '') === lane` | coercion | drop |
| `external/supersede-state.ts:98,146` `r.target_lang ?? ''` | coercion | drop |
| `external/discovery-route.ts` advertises `targetLanes` | registry excludes the default lane | registry becomes complete (§2.4) |
| `contextual-frames.ts:208` `typeof m.targetLang === "string" ? … : {}` | omit-on-wire | always emit |
| `project-do-handlers.ts` / `project-do.ts` | `ServerEventApplied.rows` is all-lanes | out of scope here; read-wall slice 5 |

### 1.3 auth-worker

| File · line | Assumes | Must become |
|---|---|---|
| `services/assignments.ts:108,238,309` `targetLang: r.target_lang ?? ""` | coercion (`getMyAssignments`, `getProjectAssignmentRoster`, `getOrgAssignmentWorkload`) | drop the coercion; the value is now always a real tag, which is what makes `AssignedToMe`'s href correct (§1.4) |
| `services/org-permissions.ts:1035` `const lane = row.target_lang ?? ""` | coercion | drop |
| **`services/org-permissions.ts:1059`** `const denominator = lanes.get("")?.totalCells ?? 0` | **the default lane's row is the denominator for every other lane's progress** | resolve to the project's migrated tag, or better: recompute the denominator from the source-row count, which is what it is actually trying to measure |
| `services/org-permissions.ts:1061` `if (lane === "" \|\| lanes.has(lane)) continue` | skip the default lane when synthesizing zero-progress lanes | drop the `lane === ""` arm |
| `services/org-permissions.ts:1068` sort pinning `""` first | default lane sorts first | sort by registry order |
| `services/org-permissions.ts:1081` `lane !== ""` filter on the registry | registry never contains the default | drop |
| `services/org-permissions.ts:948` `targetLanguage: r.target_language \|\| null` | project-level default target | keep (still the display name of the *primary* lane) |
| `routes/contextual.ts:566` `(body.targetLang ?? "").trim()` | absent ⇒ default | 400 |
| `routes/contextual.ts:906,1177` `c.req.query("targetLang") ?? ""` | absent ⇒ default | 400 |
| `routes/merge-sibling.ts:120-123` `if (!lane) → 400` | correct already | keep |
| `lib/agent/tools/select-cells.ts:206` `scope.targetLang === undefined ? "" : " AND t.target_lang = ?"` | `undefined` ⇒ **all lanes**; `''` ⇒ default lane | already tri-state and correct; but agent callers must now always pass a lane (open question 7) |
| `lib/agent/lint.ts:40` `(r.lane ?? "") === lane` | coercion | drop |
| `lib/changeset-approval-changes.ts:167,173,176` `s.laneId ?? ""`, `...(lane !== "" ? { laneId } : {})` | omit-on-wire | always emit |
| `lib/contextual/project-context.ts:365` `if (lane === "") return true` | the default lane always passes some readiness gate | re-derive; this is a silent "yes" that becomes wrong |
| `lib/billing/plans.ts:108-118` / `src/lib/billing/plans.ts:109-121` `countDistinctTargetLanes` | `targetLanguage` ∪ `targetLanes`, `Set`-deduped | **billing-neutral** under §2.4 — appending `targetLanguage` into `targetLanes` cannot double-count because the accumulator is a `Set` and both go through `normalizeLaneTag`. Verify with a test rather than trusting this sentence |
| `services/invite-scopes.ts:31` `if (!lanes \|\| lanes.length === 0) return null` | empty scope list ⇒ unscoped invite | keep (unscoped ≠ default lane) |
| `db/shared/contextual-runs.ts:812,1607,1619,1864`, `db/shared/scene-briefs.ts:279` | `?? ''`, `=== undefined` tri-state, one hardcoded `target_lang = ''` | resolve / require |

### 1.4 Frontend

| File · line | Assumes | Must become |
|---|---|---|
| **`ProjectWorkspace.tsx:1304-1309`** `useState<string>(() => readPersistedActiveLane(projectId))` | there is always an active lane, initially `''` | `useState<string \| null>(null)` — a genuine "no lane chosen" state (§4) |
| **`ProjectWorkspace.tsx:478-491`** key `aquilla:activeLane:${projectId}`; `getItem(...) ?? ""`; `if (lane) setItem else removeItem` | **missing key ⇒ default lane**, and the default lane is stored by *deleting* the key | Persist the chosen lane always. A missing key ⇒ "no choice yet" ⇒ show the chooser. Note: the existing `removeItem` branch means *every current user's* stored state is indistinguishable from "never chose," which is actually convenient — see §4.4 |
| **`ProjectWorkspace.tsx:1814-1815`** `availableLanes = ["", ...targetLanes]` | `''` is prepended and always available | `availableLanes = project.targetLanes` (registry is complete) |
| `ProjectWorkspace.tsx:1819` `if (activeLane && !availableLanes.includes(activeLane)) setActiveLaneState("")` | unknown lane falls back to default | fall back to **`null`** (chooser), never to a lane |
| `ProjectWorkspace.tsx:4253,4447` `activeLane \|\| undefined` | `''` ⇒ omit on the wire | always pass |
| `ProjectWorkspace.tsx:4201,4616` `targetLang: activeLane, // '' omitted on the wire by the emit` | omit-on-wire | always emit |
| `ProjectWorkspace.tsx:4256,4455` `(r.targetLang ?? "") === activeLane` | coercion | drop |
| `ProjectWorkspace.tsx:5545` `setActiveLane(a.targetLang ?? "")` (assignment click) | assignment without a lane ⇒ default | assignments now always carry a lane |
| **`project-workspace-lane-target.ts:35-43` `resolveActiveTargetLanguage`** — `if (activeLane) return activeLane; return projectTargetLanguage \|\| undefined` | default lane derives its language from `project.targetLanguage` | **delete the function.** Post-migration the lane tag *is* the target language for every lane, so this is `activeLane`. The whole AQU-583/AQU-602 class of bug — a stale per-file stamp shadowing the project setting — disappears with it. One of the few net simplifications |
| **`project-workspace-lane-deeplink.ts:11-16,34-36` `resolveDeepLinkLane`** — absent ⇒ `null` (keep persisted); `?lane=` ⇒ `''`; unknown ⇒ `''` | three-way, two of which land on the default lane | absent ⇒ `null` (⇒ chooser, not persisted); `?lane=` empty ⇒ `null`; unknown ⇒ `null`. **Every non-match becomes `null`, never a lane.** Simpler than today |
| `project-workspace-lane-deeplink.ts:42-61` `draftReviewHref(..., targetLang = "")` and `defaultLaneDraftReviewHref` | default parameter `""` | remove the default; delete the `@deprecated` helper |
| **`org/AssignedToMe.tsx:21-28`** `a.targetLang ? \`${base}?lane=…\` : base` | falsy `''` omits the param, so the link lands on the persisted lane | always append. This is the clearest example of "falsy `''` produces the wrong destination" |
| `org/AssignedToMe.tsx:95,211` `a.targetLang ? …` (chip render, search filter) | default-lane assignments show no chip and are unsearchable by lane | always render |
| **`AssignModal.tsx:166` `defaultLane = ""`; `:187` `useState(defaultLane)`; `:274-287` `laneItems` with `''` first; `:566` `laneItems.length > 1 &&`; `:389,460` `selectedLane \|\| undefined`** | `''` is a valid pre-selection; the select renders only when extra lanes exist; `''` submits as `undefined` | `selectedLane: string \| null = null`; render the select **always** (rule 3); block submit while `null`; submit the tag verbatim |
| `AssignModal.tsx:99-106` `defaultLaneLabel` — *"the default lane IS a real language lane"* | a cosmetic label papering over the structural problem | **delete the prop.** Post-migration the lane tag is the name. This prop (AQU-728) exists solely because `''` had no name |
| **`org/AssignWork.tsx:196-206`** `createAssignment({ jwt, projectId, fileId, author, assigneeUserId, scope, scopeKind, scopeLabel, deadline })` — **no `targetLang` at all** | every assignment created here lands in the default lane | must collect and pass a lane. This is a **functional bug today** on any N>1 project, not just a convention to update |
| `org/OrgLaneAssignModal.tsx:16-17,76` `lane: string` (`'' = default lane`), `defaultLane={lane}` | `''` launch is valid | `lane` must be a real tag; drop `defaultLaneLabel` |
| **`lib/sync/assignments.ts:247-248`** `...(args.targetLang ? { targetLang: args.targetLang } : {})` | omit-on-wire when `''` | `targetLang` becomes a required field, always emitted |
| **`lib/sync/project-settings.ts:137-140`** `targetLanes?: string[]` — *"non-default target-language lanes (`''` is always implicit, never stored)"* | registry excludes the primary lane | registry is **complete**: every lane including the primary. Doc comment rewritten. §2.4 |
| **`MemberLaneScopeEditor.tsx:136,139`** `s.value \|\| "default"` | a `''` lane scope renders as the word "default" | `''` scopes no longer exist; drop the fallback (a `''` that survives should render as a visible error, not as a friendly word) |
| `lib/sync/member-scopes.ts:38-48` `isInMemberScope` — `if (!scopes \|\| scopes.length === 0) return true`, `!laneScopes.includes(lane)` | empty/null ⇒ allowed (fail open); `''` is a comparable lane value | keep the fail-open (unscoped ≠ default lane — this is the read-wall spec's §4.3 decision and it survives). Callers must stop passing `''`; passing `null` must be a type error, not a silent match |
| **`lib/sync/role-policy.ts:291-293` `canSwitchLanes`** — `roleLevel >= ROLE.MAINTAINER` | below maintainer, the lane is a static pill and cannot be chosen | splits into two gates — §5 |
| **`EditorTable.tsx:2658-2661`** `lanes && lanes.length > 1 && onLaneChange && canSwitchLanes(...)` | **the N=1 optimization** — no switcher at all when there is one lane | render the control unconditionally; at N=1 it is a one-option control, not a hidden one |
| `EditorTable.tsx:861` `activeLane = ""`, `:2670` `label: lane === "" ? (defaultLaneLabel \|\| t("editor.column.target")) : lane` | `''` needs a synthetic label | drop the special case |
| `EditorTable.tsx:2694` trigger renders `project.targetLanguage \|\| t("editor.lane.setTargetLanguage")` | the pill shows the *project* target, not the active lane | render `activeLane`. Today on a named lane the pill shows the project's default language — arguably already a bug |
| `EditorTable.tsx:4298,5124` `isInMemberScope(myScopes, cell.fileId, activeLane)` | `activeLane` is a string | must handle `null` (no lane ⇒ nothing editable) |
| `hooks/useCells.ts:33-35` `laneOf(r) = (r as LaneCellRow).targetLang ?? ""`, `:401` `if (laneOf(r) !== lane) continue`, `:480` `lane = ""` | default parameter `''`; source rows also `laneOf === ''` | source rows must be admitted by `side`, **not** by lane equality. Today a source row and a default-lane target row are indistinguishable to `laneOf`, and the join relies on that. Making the target lane a real tag **breaks the source-row join** unless this is restructured. Sleeper defect — flag as slice-blocking |
| `hooks/useProjectCells.ts:248` `(payload.targetLang ?? "") !== lane` | coercion | resolve via the shim while legacy events are live |
| `hooks/useActiveCellStore.ts:1296,1402,1479` `pending?.targetLang === activeLane` | strict compare against a possibly-`''` lane | `null` must never match |
| `hooks/useFocusLock.ts:56` `lane ? \`${cellId}@lane:${lane}\` : cellId` | default lane's focus-lock key is unqualified | always qualify — but this key is broadcast between clients, so old and new clients disagree during rollout. Minor (a focus lock), but it is a wire-format change |
| `lib/progress/file-progress-resource.ts:105,285,500` `lane ? …lane… : …` (IDB key + query) | default lane's cache key and query omit the lane | always include. Existing cache entries become unreachable, which is the desired outcome |
| `lib/sync/plan.ts:74` `lane ? '?lane=' : base` | omit | always |
| `lib/contextual/transport.ts:194` `...(targetLang ? { targetLang } : {})` | omit-on-wire | always |
| `lib/sync/cells-cache.ts` key `${accountOwner}:${projectId}:${fileId}` | **not lane-keyed at all** | already a read-wall item (#48); the migration makes stale entries actively wrong (rows now keyed by a tag the cache does not know) — must be version-busted at cutover |
| `org/project-lanes.ts:19-30 `displayLanes`, `:37-40 laneChipLabel`, `:56-59 resolveDefaultLaneLabel` | `''` lane pinned first; synthesized default lane from scalar counts; `''` labeled from `project.targetLanguage` | `displayLanes` returns the registry; delete `resolveDefaultLaneLabel`; `laneChipLabel` becomes the identity function |
| `org/LaneChips.tsx:84`, `org/ProjectLaneSubRows.tsx:68` `key={lane.lane \|\| "__default__"}` | React key for the `''` lane | drop |
| `org/ProjectOverview.tsx:628-629,1209-1291` `activeLane ? … : …` (≈10 sites) | falsy lane ⇒ **cross-lane project totals**; truthy ⇒ per-lane | this is the *"all lanes" vs "one lane"* axis, not the default-lane axis. Must become an explicit `null`/tag discriminator or the "All lanes" overview view silently becomes unreachable |
| `project-lane-archive.ts:26` `if (!lane \|\| …) return false` — *"the default lane is never archivable"* | `''` cannot be archived | every lane is archivable ⇒ **can a project have zero unarchived lanes?** Open question 5 |
| `ProjectSettings/LanguagesSection.tsx:75,118,125` `alreadyDefaultError`, `excludeFromSuggestions = [defaultTargetLanguage, ...targetLanes]`, `validateNewLane(trimmed, defaultTargetLanguage, targetLanes)` | **`targetLanguage` must never appear in `targetLanes`** | this invariant **inverts** — §2.4 requires it to be in `targetLanes`. The `alreadyDefaultError` rule must be deleted, or the migration violates the client's own validator |
| `org/OverviewLaneTable.tsx:76-78` literal `"default"` in test IDs | test IDs only | **not a defect**, per the brief. Rename for clarity only |
| `ProjectCreateDialog.tsx` | §7 |  |

### 1.5 The falsy-`''` sites, called out as a class

The 63 sites in category C are where this change breaks silently. Ranked by consequence:

1. `org/AssignWork.tsx:196-206` — omits `targetLang` entirely. Not falsy-`''`; *absent*. Always writes the default lane. Broken today at N>1.
2. `link-sync.ts:381` `payload.targetLang !== ''` — post-backfill, no upstream commit matches, and **every `consumes: 'target'` chain silently stops replicating**. Fails as "the downstream stopped updating," days later.
3. `org-permissions.ts:1059` `lanes.get("")?.totalCells ?? 0` — the org portfolio's progress denominator becomes `0`, so every lane's percentage becomes `0%` or `NaN` across the whole dashboard.
4. `export-route.ts:58` / `export-bundle-route.ts:53` `?? ""` — a lane-less export request silently produces an empty file instead of erroring.
5. `useCells.ts:401` `laneOf(r) !== lane` — source rows stop joining (they are `''`, the target lane is not). The editor renders empty. Loud, but only if someone runs it.
6. `progress-read-route.ts:213,281` ETag `lane ? ':lane:' : ''` — the pre-migration default-lane ETag equals the post-migration unrestricted ETag, so warm clients get `304` against pre-migration bodies **through the cutover**.
7. `AssignedToMe.tsx:21-28` — the deep link omits `?lane=`, landing the assignee on whatever lane they last used. A translator types into the wrong language and nothing warns them. Worst *data* outcome of the falsy class.
8. `prepare.ts:430` `variant.laneId || cmd.targetLanguage || ''` — a triple fallback; the middle arm is exactly the implicit defaulting rule 2 bans, via the Agent API.
9. The ~20 `...(lane ? { targetLang: lane } : {})` omit-on-wire spread sites — each one, left unfixed, keeps minting `''` events after the backfill. They are the reason the shim in §3.2 is mandatory rather than optional.

---

## 2. The data migration plan

### 2.1 Where the replacement tag comes from

`project_settings.target_language` (the migration-0054 generated column over
`settings->>'targetLanguage'`). It is the only per-project value that already means "the language
the default lane is being translated into," and `resolveActiveTargetLanguage` and
`resolveDefaultLaneLabel` already treat it as authoritative.

**Do not derive it from files.** `project-workspace-lane-target.ts` documents at length (AQU-583)
why the per-file `targetLanguage` is untrustworthy: it is an import-time snapshot, a stale one
shadowed a later Settings change, and a stamped `"English"` once masked an unset project target.
Reusing it in the migration would resurrect exactly those two bugs, permanently, in primary-key
data.

### 2.2 Pre-flight audit — a report, not a guess

The migration is **preceded by a read-only audit script** whose output a human signs off on. Per
project with at least one `target_lang = ''` target row (or `''` assignment/validator/progress/
scope row), classify:

| Class | Condition | Disposition |
|---|---|---|
| **CLEAN** | `target_language` non-blank after trim, and no case-insensitive match in `targetLanes` | Auto-migrate |
| **BLANK** | `target_language` NULL, absent, or whitespace | **Quarantine.** Do not guess. Two sub-cases: (a) zero `''` target rows and zero `''` assignments ⇒ nothing to backfill, just needs a registry entry before anyone can work in it; (b) real content in an unnamed lane ⇒ a human names it. Do **not** invent `und`: a BCP-47 "undetermined" tag would become a permanent primary-key value and would show up in the lane switcher as a real choice |
| **COLLIDE** | `target_language` case-insensitively equals an existing `targetLanes` entry | **Quarantine.** The default lane and a named lane are the same language, so backfilling collides on `cells_pkey` `(project, file, cell, side, target_lang)` — this is a **content merge**, not a rename. Two rows, two values, two chain heads, one destination key. Resolve per project via the existing `merge-sibling` fold (which is exactly this operation, already built, lead-gated, with provenance) or by renaming one lane. Never by `ON CONFLICT DO NOTHING`, which would silently discard one language's translation |
| **ARCHIVED-COLLIDE** | as COLLIDE, but the named twin is in `archivedLanes` | Quarantine; likely resolution is to un-archive the twin and merge, since the archived lane is probably an earlier attempt at the same language |

The audit must also report, per project: `''` row counts per table, distinct `''` target values
that differ from the twin's (for COLLIDE), and whether any events exist. Expect COLLIDE to be
non-trivially common: the AQU-728 `defaultLaneLabel` work exists precisely because people were
confused about the default lane's identity, and `LanguagesSection`'s `alreadyDefaultError` proves
someone tried to add their own default language as a lane.

### 2.3 The backfill itself

Per project, in one transaction, keyed on a recorded `resolved_lane`:

```
-- shape only; not the migration file
UPDATE cells               SET target_lang = :tag WHERE project_id = :p AND side = 'target' AND target_lang = '';
UPDATE cell_validators     SET target_lang = :tag WHERE project_id = :p AND target_lang = '';
UPDATE assignments         SET target_lang = :tag WHERE project_id = :p AND target_lang = '';
UPDATE artifact_import_bindings … (binding_role = 'target' only)
UPDATE scene_briefs / contextual_runs / contextual_drafts …
UPDATE project_member_scopes SET value = :tag WHERE project_id = :p AND kind = 'lane' AND value = '';
```

Notes that matter:

- **`side = 'target'` on `cells` is not optional.** Omitting it destroys every project's source
  text identity (§0). This is the one line in the whole plan where a mistake is unrecoverable
  without a PITR restore.
- **`cell_validators` and `file_section_progress` need no `side` clause** — verified target-only
  (`progress-projection.ts:106-129,237-263` derives lanes from `WHERE side='target'`).
- **`file_section_progress` should be recomputed, not updated.** It is a pure projection over
  `cells`, and `fullProgressRecomputeStmts` already exists and re-derives the lane set from
  `SELECT DISTINCT target_lang … WHERE side='target'`. Recomputing after the `cells` update is
  both simpler and self-healing; updating it risks a `(scope, section_key, target_lang)` PK
  collision if any `''`-lane row already coexists with a `:tag` row.
- **This is an UPDATE of a primary-key column** on the largest table in the system. On a
  meaningful `cells` it is a full-table rewrite of the affected rows plus index maintenance on
  `cells_pkey5` and `idx_cells_file_scan`. Batch by `(project_id, file_id)` with a bounded
  statement timeout; follow the `docs/runbooks/2026-07-14-aqu538-neon-main-rollout.md` pattern.
- **Idempotent** by construction: the `WHERE target_lang = ''` predicate is self-consuming. A
  second run touches zero rows.
- **Reversible**, conditionally. Record every decision in a new
  `default_lane_migration(project_id PK, resolved_lane, ran_at, rows_by_table JSONB)` table.
  The inverse is `SET target_lang = '' WHERE target_lang = :recorded_tag AND side = 'target'`.
  This is **lossy iff the project already had a named lane with that tag** — which is exactly
  the COLLIDE class, which is exactly why COLLIDE is quarantined rather than merged
  automatically. Reversibility is a property of the audit gate, not of the SQL.
- `default_lane_migration` is **not** temporary scaffolding. It is the lookup the replay shim
  needs (§3.2) and must outlive the migration.

### 2.4 Does the tag go into `targetLanes`?

**Yes, and this is a required part of the migration, not a follow-up.**

`targetLanes` becomes the complete lane registry. Everything downstream depends on it:
`availableLanes`, `AssignModal.laneItems`, the `?lane=` resolver, `discovery-route`'s advertised
registry, `LaneCombobox`, `project-lane-archive`. If the migrated tag is not registered,
`ProjectWorkspace.tsx:1819` sees an unknown active lane and — post-fix — drops the user to the
chooser, which then does not list the lane their data is in. That is a total lockout.

Three consequences:

- **`LanguagesSection`'s `alreadyDefaultError` must be deleted** (`:75,118,125`). Today it
  actively forbids the state the migration creates. Ship that deletion **before** the settings
  write, or the next settings save round-trips through a validator that rejects its own data.
- **Ordering:** put the primary tag first, preserving today's "default lane sorts first" display
  order for free and keeping `org-permissions.ts:1068`'s intent without its `""` special case.
- **Billing is neutral.** `countDistinctTargetLanes` accumulates into a `Set` over
  `normalizeLaneTag`, adding `targetLanguage` and each of `targetLanes` — so the tag being in
  both is already deduped. Pin this with a test before the migration; it is the kind of
  invariant that silently changes an invoice.
- `settings` is a versioned optimistic-concurrency blob (`patchProjectSettings(…, version)`), so
  the registry write cannot be a bare SQL `UPDATE` alongside the `cells` backfill without racing
  a concurrent settings save. Either go through the settings route per project, or take the
  version into the transaction and retry on conflict. **This is why the registry write is its own
  slice (S1) and lands well before the backfill.**

### 2.5 Historical events and replay — yes, this is a real problem

**Direct answer: yes. Replaying historical events after the migration reintroduces the default
lane, and it does so as silent data duplication rather than as an error.**

Mechanically:

- Every pre-AQU-538 `target.cell.commit` has **no** `targetLang` key. Every default-lane commit
  since has it **omitted deliberately** — `assignments.ts:247` and `ProjectWorkspace.tsx:4201`
  both carry the comment *"`''` omitted on the wire."* The AQU-538 spec calls this out as a
  design goal: *"clients omit `''` on the wire so default-lane events stay byte-identical."*
- `laneOfEvent(kind, payload)` (`event-projection.ts:145-149`) maps absent-or-non-string ⇒ `''`.
- `rebuild.ts:124` and `scripts/lib/fold-projection.ts:58` both key their replay off
  `laneOfEvent`.

So after the backfill, any rebuild — the admin `/rebuild` route, a fold-projection run, the
lazy re-projection paths — re-derives `target_lang = ''` for every historical cell and writes it
via `ON CONFLICT (project_id, file_id, cell_id, side, target_lang)`. The `''` key does not
conflict with the `:tag` key, so **you get two rows for the same cell**: the migrated one at
`:tag` and a resurrected one at `''`, each with its own `event_id` chain head. The `CHECK`
constraint from §1.1 turns this into a loud failure instead of a silent fork — which is why the
CHECK is a *safety mechanism*, not a tidiness exercise, and why it must land with the backfill.

**Do not rewrite the events.** Three reasons: it violates the append-only contract the whole
system rests on; `events` is the hot write table and a payload rewrite is the most expensive
possible migration; and `chain_claims.parent_key` was computed from those payloads, so rewriting
them desynchronizes the arbitration table (§2.6).

**The fix — a resolution shim.** `laneOfEvent` gains a third argument:

```ts
// shape only
export function laneOfEvent(kind: string, payload: unknown, projectDefaultLane: string): string {
  if (!kind.startsWith('target.cell.')) return ''            // source: unchanged, still ''
  const lang = (payload as { targetLang?: unknown })?.targetLang
  return typeof lang === 'string' && lang !== '' ? lang : projectDefaultLane
}
```

`projectDefaultLane` comes from `default_lane_migration` (§2.3), memoized per request the way
`RequestCache.projectSettings` already is. Every call site must be threaded:
`event-projection.ts`, `rebuild.ts:124`, `scripts/lib/fold-projection.ts`, `authorize.ts`'s lane
extraction, `link-sync.ts:381`, and the client mirrors in `useProjectCells.ts:248` and
`ws-reconciler.ts`.

Properties: the event log stays immutable; replay is *identical* pre- and post-backfill (the shim
resolves `''` to the tag whether or not the backfill has run yet, so replay converges to the same
projection either way); and it makes the code-deploy and the backfill **order-independent**,
which is the single most valuable property in this plan (§8.1). The shim is permanent for as long
as any legacy event exists, i.e. forever, and should be documented as such rather than marked
TODO-remove.

For a project with **no** `default_lane_migration` row (created after the cutover, so every event
carries an explicit tag), the shim must **throw**, not default. A missing mapping combined with a
legacy-shaped event is a bug, and the only safe response to "I cannot determine which lane this
text belongs to" is to refuse.

### 2.6 `chain_claims` — the second persisted encoding

`chain-claims.ts:64,99`: `targetLang ? \`${base}@lane:${targetLang}\` : base`. The default lane's
AD-2 arbitration slot is the **unqualified legacy key**, and existing `chain_claims` rows carry
it. The file is explicit that all three arbitration sites — the live claim, `rebuild.ts`'s
in-memory `childKey`, and `isWinningChild`'s sibling filter — must compute the same key *"or
replay diverges from live."*

Two options:

- **(A) Leave the chain key deriving from the raw payload.** Legacy events keep unqualified keys,
  new explicit-tag events get `@lane:<tag>`. No `chain_claims` backfill, nothing irreversible.
  Cost: a legacy default-lane event and a new explicit-tag event that share a parent take
  *different* slots, so both win their claim. The existing compare-and-swap on
  `cells.event_id = parentId` (AQU-1154) is the backstop — only one advances the row, and the
  loser is reported via the response `stale` array, which is the already-designed behaviour.
- **(B) Route the chain key through the shim too**, so both compute `@lane:<tag>`, and backfill
  `chain_claims.parent_key`. Consistent, but it rewrites the arbitration table, is not cleanly
  reversible, and a wrong backfill lets a stale branch climb back onto a head — the exact bug
  AQU-1154 fixed.

**Recommend (A)**, with a characterization test constructing precisely the straddling case (a
legacy unqualified commit and a new tagged commit sharing one parent) and asserting live and
replay agree. If that test cannot be made to pass, (B) becomes mandatory and the project's risk
profile changes materially. **Write that test in slice 0**, before committing to the sequence.

---

## 3. The forced-choice UX

### 3.1 Workspace entry — recommendation

**There is a genuine "no lane selected" state, and the editor does not render in it.**

`activeLane: string | null`, initialized to `null`. When `null`, the editor route renders a
**full-panel lane chooser** in place of `EditorTable`: project name, the file being opened, and
one card per registered lane (tag, per-lane progress from `file-progress-resource`, "N assigned
to you"), archived lanes behind the existing reveal. Choosing one sets the lane, persists it, and
renders the editor.

Rejected alternatives, and why:

- **Modal over a rendered editor.** The editor behind it must have committed to *some* lane to
  render rows, which is the implicit default this project exists to remove.
- **Render the source pane read-only with an empty target column.** Tempting — it shows the
  document — but an editor with a visible source and a blank target is an invitation to type,
  and the honest answer to "type where?" is "nowhere yet." It also does not help: the source pane
  is identical for every lane, so it conveys no information the chooser cannot.
- **Auto-select when N=1.** Explicitly forbidden by rule 3. And it is the rule most likely to be
  quietly re-broken later as a "UX improvement," so the acceptance test for N=1 should be written
  as an explicit anti-regression with a comment saying so.

**What makes this humane rather than a tax.** The persisted lane becomes a *pre-highlighted,
keyboard-focused* card rather than an auto-selection, so the returning user's interaction is one
`Enter`. And crucially, an explicit `?lane=<tag>` deep link **is** an explicit choice — the user
clicked a link naming the lane — so the whole PM → assignee flow keeps its single click. In
practice the chooser is seen on first entry to a project and after a lane is removed, not daily.
This is what makes rule 2 affordable; without deep links counting, it would not be.

**Rollout freebie:** `ProjectWorkspace.tsx:490-491` stores the default lane by *deleting* the
localStorage key. So today's default-lane users are already in the "no key" state that the new
code reads as "never chose," and they land on the chooser with no migration of client state.
Users on a named lane keep it. That is an unusually clean cutover for a client-state change.

### 3.2 Assign flows

**`AssignModal`** — `selectedLane: string | null = null`; the lane select renders **always**
(delete the `laneItems.length > 1` gate at `:566`); no `''` option; `defaultLane` /
`defaultLaneLabel` props deleted; Assign disabled with inline "Choose a language lane" while
`null`; submit sends the tag verbatim (delete `selectedLane || undefined` at `:389,460`). When
launched from a lane sub-row, `OrgLaneAssignModal` passes a real tag and it is pre-selected — a
pre-selection made by an explicit user action on a named lane, which satisfies rule 2.

**`org/AssignWork.tsx`** — the largest single piece of new UI. It currently has **no lane concept
at all**, so it needs the lane control, the project's registry (it does not fetch settings
today — check whether `useProject` is available in its tree or a fetch must be added), and the
`targetLang` argument. Ship the fix that makes it *pass a lane* before the migration: it is a
genuine bug at N>1 today and fixing it is independently valuable.

### 3.3 Project creation wizard

See §7.

### 3.4 The `?lane=` deep link

`resolveDeepLinkLane` collapses to: **anything that is not an exact match against the registry
returns `null`** (⇒ chooser). Absent, present-and-empty, and unknown-tag all become `null`. The
current three-way rule (absent ⇒ keep persisted, empty ⇒ default, unknown ⇒ default) has two arms
that violate rule 2 and one that violates it indirectly.

Also delete `defaultLaneDraftReviewHref` and the `targetLang = ""` default parameter on
`draftReviewHref` — a helper whose *default* is the implicit lane is a defaulting site by
construction.

An unknown-tag link deserves a message, not a silent chooser: *"That link points to a language
lane that isn't on this project — pick one below."* Otherwise the archived-lane and
renamed-lane cases look like a bug.

---

## 4. Reconciliation with the two in-flight workstreams

### 4.1 `2026-09-09-lane-read-wall-design.md` — it exists, and this changes it in eight places

| Read-wall section | Its conclusion | After eliminating `''` |
|---|---|---|
| **§4.1** "The empty-string default lane — the single most likely source of bugs" (its longest edge-case section) | `''` is falsy; `?lane=` must become **tri-state** (absent / present-empty / present-value); `project_member_scopes` accepting `''` is *"Good; keep it, and add a test pinning it"*; `lanes.has(row.target_lang ?? '')` never `if (lane)` | **Largely deleted.** `?lane=` becomes **required**, i.e. two-state (present-valid / 400), which is simpler than tri-state. The `''`-in-`project_member_scopes` recommendation **inverts**: `''` becomes illegal and gets a `CHECK` plus a `.min(1)` zod refinement. The `cells-read-route.ts:601` bug it identifies stops being a bypass and becomes a validation error |
| **§4.10** ETags | *"a lane set of `{''}` and a lane set of `null` must produce different ETags"*; `progress-read-route`'s `:lane:` suffix collides for the default lane | The `{''}` case disappears. But the **suffix must become unconditional anyway**, and for a new reason: through the migration window, the pre-migration default-lane ETag equals the post-migration unrestricted ETag, so a warm client gets a `304` against a body from before the backfill. Same conclusion, different and more urgent cause |
| **§6** citing AQU-538 | *"Source rows are always lane `''`. The source exists once, shared by all lanes"* ⇒ `laneReadPredicate` must pass source rows unconditionally | **Survives, and becomes the load-bearing statement of §0.** Should be restated as "source rows are not lane-addressable; `''` is that sentinel" so a future reader does not read it as a surviving default lane |
| **§6** citing AQU-538 | *"clients omit `''` on the wire so default-lane events stay byte-identical"* ⇒ *"the tri-state param is the reconciliation"* | The omit-on-wire convention is **deleted**; the tri-state reconciliation is unnecessary |
| **§4.4** linked projects | `foldTargetLaneDelta` skips `payload.targetLang !== ''` ⇒ *"chains do not currently fan out across lanes, and the read wall does not need to teach them to"* | The premise holds but the **implementation breaks**: post-backfill nothing matches `''`, and every `consumes: 'target'` chain silently stops syncing. The read wall's conclusion is unchanged; the *code* needs the shim |
| **§4.4** sibling-merge | *"folds a donor's **default lane** into a new host lane"* | The donor read (`merge-sibling-route.ts:104`) must resolve the donor's tag. Note the pleasing symmetry: `merge-sibling` is **already the tool** for the COLLIDE class in §2.2 |
| **Slice 8** | add `target_lang` to `cell_audio` / `cell_backtranslations` / `cell_waivers` / `cell_links`, *"defaulting `''`"*, then backfill | **Must not default `''`.** Either default to the project's resolved lane, or make the column `NULL`-able where the row genuinely is not lane-specific. If slice 8 ships `DEFAULT ''` before this project, it creates four *new* tables' worth of default-lane rows to migrate |
| **§3.4** resolution order, step 4 | *"lane scopes present in claims.scopes -> Set(values) (`''` is a legitimate member)"* | `''` is no longer a legitimate member; the parenthetical is deleted |
| **§4.3** unscoped members ⇒ all lanes | Argues at length that "isolated" must not mean "invent a default-lane-only scope," partly because *"every member of every existing N=1 project — where the only lane is `''`"* | **Conclusion survives, one supporting argument evaporates.** After this project there is no `''` to scope anyone to, so the "no-op at N=1" argument disappears. The main argument (silent mass permission change) is untouched. Its proposed `'strict'` third value would need rewording — "the default lane only" has no referent |
| **§7 open question 1** | Confirm unscoped ≠ implied default-lane scope | Becomes moot in its current wording |

**Sequencing between the two projects.** They collide on `cells-read-route.ts`, the ETag
composition, `project_member_scopes` semantics, and read-wall slice 8. Recommendation: **land the
`''` elimination first, or at minimum land its §S1–S5 (registry + shim + writes) before read-wall
slice 3.** The read wall's hardest section (§4.1) is *entirely* about `''` being falsy; doing it
after this project deletes that section rather than implementing it. Doing it before means
building the tri-state param and then deleting it.

### 4.2 Lane-scoped switching vs. the `canSwitchLanes` gate

The decision: scoped members may switch among their own scoped lanes; unscoped users keep the
Maintainer-600+ gate at `role-policy.ts:291-293`. Forced choice makes this **strictly easier**,
because it separates two things the current single gate conflates — *choosing* a lane and
*changing* it.

`canSwitchLanes` splits:

- **`laneChoicesFor(scopes, registry): string[]`** — what may this user choose from? Scoped ⇒ the
  intersection of `registry` and their lane scopes. Unscoped ⇒ the whole registry.
- **`canChooseLane`** — **always true** for anyone who can open the project. Rule 2 makes the
  initial choice mandatory, so it cannot be role-gated; there is no fallback to gate *to*.
- **`canSwitchLaneAfterEntry(roleLevel, scopes)`** — `true` if the user has ≥ 2 entries in
  `laneChoicesFor`, **and** (`scopes` has lane rows **or** `roleLevel >= ROLE.MAINTAINER`). This
  is the existing AQU-608 gate, narrowed to the post-entry case and relaxed for scoped members.

Note the inversion this produces, and check it is intended (open question 6): an **unscoped
translator** at role 400 can choose a lane on entry but cannot change it without reopening the
project; a **scoped translator** at the same role can switch freely among their two scoped lanes.
That is defensible — a scope is an explicit grant naming those lanes — but it is not obvious.

**Empty scope list.** `member-scopes.ts:31` and `invite-scopes.ts:31` both already mean
"unscoped," and the read-wall spec defends that at length. Keep it: empty ⇒ full registry.

**Scopes still loading** is the case that needs deliberate design, and it is new — today a
translator sees a static pill and `myScopes` loading is invisible. Now it gates a mandatory
choice, so:

- **Do not render the chooser optimistically as unscoped.** Rendering the full registry and then
  removing options is worse than a spinner: a user may click a lane they are not scoped to,
  the write is rejected by `authorize()`, and the failure surfaces as an outbox 403 minutes later.
- Render an explicit loading state on the chooser; block selection until `myScopes` resolves.
- On **fetch failure** (`fetchMemberScopes` returns `null` — indistinguishable from 403 today),
  `isInMemberScope` deliberately fails **open** so the client never hides an action the server
  would allow. Applying that here means offering the full registry, which risks the wrong-lane
  write above. Recommendation: **offer the full registry (stay consistent with `isInMemberScope`)
  but show a visible "couldn't confirm your language access" banner and retry**, rather than
  inventing a second, contradictory failure polarity for the same data. Open question 6.
- **Zero choices** — a scoped member whose scoped lanes are all archived or none are registered.
  Today they silently land on `''`. Now it must be an explicit "you have no language lanes on
  this project; ask a project lead" screen. This state is currently unreachable and will be
  reached.

---

## 5. Project creation wizard impact

Current state on this branch (`ProjectCreateDialog.tsx`): `targetLanguage` is a required
non-blank field (`:160-165`); `extraLanguages` collects up to `MAX_TARGET_LANE_BOXES = 10` boxes
then a comma/newline overflow textarea; total capped at `MAX_TARGET_LANES = 50`
(matching `MAX_INVITE_SCOPE_LANES`); the "Source Only" shape is gone; create does
`createCloudProject` → `patchProjectSettings({sourceLanguage, targetLanguage})` → optional link →
best-effort `patchProjectSettings({targetLanes: extrasToApply})` (`:225-300`).

So the dialog **already forces at least one named target language**. The gap is in what it
*writes*: `targetLanguage` goes to the settings blob and the extras go to `targetLanes`, so lane
#1 is registered only as `targetLanguage` and its cells will be written at `''`. **Every project
created by the current dialog is a new default-lane project.**

Required changes:

1. **Write the primary into `targetLanes` too.** `targetLanes: [primary, ...extras]`. Requires
   `LanguagesSection`'s `alreadyDefaultError` to be gone first (§2.4). Keep writing
   `targetLanguage` — the org portfolio and billing read it, and it stays meaningful as "the
   project's primary language."
2. **Merge the two settings PATCHes into one.** Today the extras PATCH is *best-effort* with an
   `EXTRA_LANGUAGES_WARNING` ("Project created; adding extra languages failed"). Post-change that
   failure mode becomes **a project with no registered lanes**, i.e. one that cannot be opened
   past the chooser. One PATCH carrying `{sourceLanguage, targetLanguage, targetLanes}`, and if it
   fails the create must fail visibly or route to a repair step. The two-PATCH shape also
   re-reads the version (`fetchProjectSettings` at `:283`) purely because it wrote twice —
   merging removes that read.
3. **Retire `filledTargetLaneCount`'s `Math.max(…, 1)`** (`:140`). It floors the count at 1 so an
   empty form reads as singular; with a hard "≥1 named lane" requirement the real count is never 0
   and the clamp hides an invalid state instead of surfacing it.
4. **`MAX_TARGET_LANES = 50` now counts the primary.** Confirm the intended ceiling is 50 total
   (not 1 + 50). Since it is pinned to `MAX_INVITE_SCOPE_LANES` so *"a project can never hold more
   lanes than a single invite is able to scope somebody to"*, 50 total is the correct reading —
   and today's `1 + 50` already violates that invariant by one.
5. **Linked-target shape.** `linkConsumes === 'target'` chains consume the upstream's default lane
   (`link-sync.ts:381`). A newly created downstream must record *which upstream lane* it consumes,
   and the upstream no longer has a default. Either the wizard asks (best), or the link records
   the upstream's primary tag at creation time. This is the one create-flow change that is not
   mechanical, and it needs the same treatment for existing links (open question 3).
6. **First-open still shows the chooser.** Even though the creator just typed the languages, rule
   2 applies on entry. Acceptable, and mildly useful at N>1. Do not special-case it — a
   "just-created ⇒ auto-select" exemption is the N=1 optimization wearing a different hat.

---

## 6. Sliced implementation plan

Sizes: **S** ≈ under a day · **M** ≈ 1–3 days · **L** ≈ a week+.

| # | Slice | Size | Risk | Depends on | Notes |
|---|---|---|---|---|---|
| **0** | **Characterization tests + audit script.** Pin today's `''` behaviour across `laneOfEvent`, `rebuild` replay, `link-sync` fold, `AssignModal` submit, deep-link resolution, `useCells` source join. **Plus the §2.6 chain-key straddle test** (legacy unqualified + new tagged commit sharing a parent; assert live == replay). Plus the read-only pre-flight audit (§2.2) run against a production snapshot. No production code | M | — | — | The audit output decides whether this project is 3 weeks or 3 months. Run it first |
| **1** | **Registry completeness.** Delete `alreadyDefaultError`; `targetLanes` doc comment; `ProjectCreateDialog` writes `[primary, ...extras]` in one PATCH; billing `Set`-dedupe test. Existing projects unchanged; nothing reads the registry differently yet | S | Low | 0 | Settings-only, fully reversible |
| **2** | **Backfill the registry for existing projects.** Per project, append `target_language` to `targetLanes` via the settings route (version-safe, §2.4). CLEAN class only; quarantine reported | S | Low | 1 | Reversible. `''` still the lane everywhere; only the registry grew |
| **3** | **`default_lane_migration` table + the replay shim.** `laneOfEvent(kind, payload, defaultLane)`; thread `event-projection`, `rebuild`, `fold-projection`, `authorize`, `link-sync`, `useProjectCells`, `ws-reconciler`. Populate the table from `target_language` for CLEAN projects. **No data changes** — the shim resolves `''` ⇒ tag on read/replay, so behaviour is identical whether or not the backfill has run | M | Med | 2 | **The keystone.** Makes slices 4 and 5 order-independent. Must not be skipped or reordered |
| **4** | **Stop writing `''`.** Every omit-on-wire spread → always emit; `AssignWork` gains a lane (fixes a live N>1 bug); `assignments.ts` `targetLang` required; `assignment-events.ts` rejects absent; every `?lane= ?? ''` route → 400; ETag suffixes unconditional; `prepare.ts:430` triple-fallback removed. Split by surface: 4a sync-worker writes, 4b auth-worker/external, 4c client emit | M | Med | 3 | Safe pre-backfill *because of* slice 3 |
| **5** | **THE BACKFILL.** Batched per project/file, CLEAN only, `default_lane_migration` recorded. `file_section_progress` recomputed rather than updated | M | **HIGH** | 3, 4 | **Irreversible in practice.** Requires 3 for replay safety and 4 so nothing re-mints `''` behind it. Per-project atomic, not per-table |
| **6** | **`CHECK` constraints + drop `assignments.target_lang DEFAULT ''`.** `side <> 'target' OR target_lang <> ''` on `cells`; flat checks on the seven other tables and `project_member_scopes` | S | **HIGH** | 5 | The machine-enforced invariant. Will surface every missed write site as an error — that is the point. **Validate `NOT VALID` first, then `VALIDATE CONSTRAINT`** to avoid a long exclusive lock |
| **7** | **Quarantine resolution.** Per-project human work: BLANK ⇒ name the lane; COLLIDE ⇒ `merge-sibling` fold or rename. Then re-run 5 and 6 for those projects | L | **HIGH** | 5 | Sized by the slice-0 audit. Could be zero, could dominate the project |
| **8** | **Forced choice — workspace.** `activeLane: string \| null`; the chooser panel; localStorage semantics; `resolveDeepLinkLane` collapse; delete `resolveActiveTargetLanguage`; `availableLanes = registry`; **remove the N=1 no-switcher optimization**; `useCells` source join restructured by `side` | M | Med | 5 | The `useCells` join is the sleeper (§1.4) — it may need to precede slice 5 |
| **9** | **Forced choice — assign flows.** `AssignModal` always-rendered required select; delete `defaultLane` / `defaultLaneLabel`; `OrgLaneAssignModal` | S | Low | 8 | |
| **10** | **Scope-aware lane choice.** `laneChoicesFor`; split `canSwitchLanes` into `canChooseLane` / `canSwitchLaneAfterEntry`; loading and zero-choice states; `MemberLaneScopeEditor` drops `\|\| "default"` | S | Med | 8 | Reconciles §4.2 |
| **11** | **Read-side cleanup.** Drop the ~40 `r.target_lang ?? ''` coercions; `files-read-route`'s hardcoded `''` join; `org-permissions` denominator, sort, and registry filter; `project-lanes.ts` synthesized default lane | S | Low | 6 | Mechanical once 6 makes `''` impossible |
| **12** | **Cache-identity bust.** `cells-cache` and `file-progress-resource` IDB keys; the `chainCache` key. Overlaps read-wall slice 6 — coordinate | S | Med | 5 | Stale pre-migration entries are actively wrong, not merely stale |
| **13** | **Linked-project lane pinning.** Record which upstream lane each `consumes: 'target'` link consumes; wizard question; backfill existing links | M | Med | 5 | Open question 3 |

**Ordering constraint, stated plainly.** The naive sequence has a trap: stop writing `''` before
the backfill and a project's history sits at `''` while new commits sit at `:tag` — a **silent
per-cell fork**, two rows, two chain heads, two translations, no error. Backfill first and every
un-updated write site immediately re-mints `''` behind it. **Slice 3's shim dissolves the
constraint** by making `''` and `:tag` denote the same lane at every read, replay, and
authorization site, so 4-then-5 and 5-then-4 converge. That is the entire reason slice 3 exists,
and it is why "just do the migration" is the wrong instinct here.

**Irreversible / risky:** 5 (PK-column rewrite on the largest table), 6 (locks; surfaces
everything missed), 7 (content merges), 13 (silently stops chain replication if wrong).
**Require the backfill to have run:** 6, 7, 11, 12, and the *acceptance* of 8–10 (they can be
built earlier but not verified).

---

## 7. Test impact

**Will need behavioural rewrites (assert the default lane, not a coincidence):**

| Test | Encodes |
|---|---|
| `src/components/AssignModal.test.tsx:515-528` | *"still submits the default lane as `targetLang=undefined`"* — asserts the exact behaviour being removed. Also the whole `defaultLaneLabel` block (`:505-535`) goes with the prop |
| `sync-worker/src/__tests__/assignment-events.test.ts:150-165` | *"defaults `target_lang` to the empty string when the lane is absent"* — must invert to "rejects an assignment with no lane" |
| `src/lib/sync/assignments.test.ts:120-147` | *"includes `targetLang` when non-`''`, and omits it when `''` or absent"* — the omit-on-wire contract, asserted three ways |
| `src/components/EditorTable.laneSwitcher.test.tsx` | the `lanes.length > 1` render gate and the `''` label |
| `src/components/project-workspace-lane-deeplink.test.ts` | all three fall-back-to-`''` arms |
| `src/components/EditorTable.lane.test.tsx` | active-lane row filtering with `''` |
| `src/components/EditorTable.targetLanguageControl.test.tsx` | `resolveActiveTargetLanguage` / the "Set target language" prompt, both of which are deleted |
| `sync-worker/src/__tests__/target-lang-lanes.test.ts` | the AQU-538 lane suite; the `''` cases invert |
| `sync-worker/src/__tests__/authorize-scopes.test.ts` | `''` as a scope value in `enforceScopes` |
| `sync-worker/src/__tests__/cells-read.test.ts` · `src/lib/sync/cells-read.test.ts` | `?lane=` absent/empty behaviour |
| `sync-worker/src/__tests__/files-read.test.ts` | the hardcoded `target_lang = ''` progress join |
| `sync-worker/src/__tests__/lane-validators-progress.test.ts` | `''` lane rows in `cell_validators` / `file_section_progress` |
| `sync-worker/src/__tests__/event-projection.test.ts` | `laneOfEvent` signature and every `''` expectation |
| `sync-worker/src/__tests__/fold-projection.test.ts:41-42` | `lane ? '@lane:' : ''` key composition (mirrors `chain-claims`) |
| `sync-worker/src/__tests__/merge-sibling.test.ts` · `auth-worker/.../merge-sibling.test.ts` | the donor's default-lane read |
| `sync-worker/src/__tests__/export-route.test.ts:107` · `export-bundle-route.test.ts` | `lane ? '?lane=' : ''` |
| `sync-worker/src/__tests__/plan-read.test.ts:39` | same idiom |
| `sync-worker/src/__tests__/import-reconcile-route.test.ts` · `import-route.test.ts` | `?? ''` lane resolution |
| `sync-worker/src/__tests__/external-*.test.ts` (changesets, project-commands, import, mcp, discovery, permission-parity) | optional `laneId` |
| `sync-worker/src/__tests__/events-route.test.ts` · `changeset-supersede.test.ts` · `supersede.test.ts` | lane-qualified cell keys |
| `auth-worker/src/__tests__/org-portfolio.test.ts` | the `lanes.get("")` denominator and `''`-first sort |
| `auth-worker/src/__tests__/contextual-runs.test.ts:61,85` · `contextual-waves.test.ts:114-116` · `contextual-tick.test.ts:661` | `targetLang ?? ""` and `targetLang \|\| "default"` fixture idioms |
| `auth-worker/src/__tests__/changeset-approvals.test.ts:112` | `args.targetLang ?? ""` |
| `auth-worker/src/__tests__/contextual-project-context.test.ts` | `if (lane === "") return true` readiness |
| `auth-worker/src/__tests__/agent-tools.test.ts` | `select-cells` lane predicate tri-state |
| `src/components/org/AssignedToMe.test.tsx` | the `a.targetLang ? …?lane= : base` href |
| `src/components/org/project-lanes.test.ts` | `displayLanes` synthesized `''`, `laneChipLabel`, `resolveDefaultLaneLabel` |
| `src/components/project-lane-archive.test.ts` | *"the default lane is never archivable"* |
| `src/components/org/ProjectOverview.test.tsx` · `OrgHome.test.tsx` · `OrgProjectsDataTable.test.tsx` | `''` lane chips / sub-rows |
| `src/components/ProjectCreateDialog.extraLanguages.test.tsx` · `.addAsLane.test.tsx` · `.linked.test.tsx` | primary-excluded-from-`targetLanes`, the two-PATCH flow, `alreadyDefaultError` |
| `src/hooks/useCells.test.tsx` | `laneOf` / source-row join |
| `src/hooks/useProjectCells.test.ts` · `src/lib/sync/ws-reconciler.test.ts` | `(payload.targetLang ?? '') !== lane` |
| `src/lib/progress/file-progress-resource.lane.test.ts` | conditional lane in the IDB key and query |
| `src/lib/sync/cells-cache.test.ts` | cache identity (slice 12) |
| `src/lib/sync/events-emit.test.ts` · `bulk-import*.test.ts` · `source-upload.test.ts` · `source-export.test.ts` | lane on the wire |
| `src/lib/billing/plans.test.ts` · `auth-worker/.../billing-plans.test.ts` | `countDistinctTargetLanes` with the primary in both places — **add this test before slice 2** |
| `sync-worker/src/__tests__/helpers/in-memory-db.ts:631` | the lane bind-order shim; fixtures seeding `target_lang: ''` |
| `sync-worker/src/__tests__/hot-query-plans.test.ts` | index/plan assertions if predicates change |

**New tests required:**

- `laneOfEvent` shim: legacy absent, legacy explicit `''`, explicit tag, source kinds, and
  **throws on a missing `default_lane_migration` row**.
- The §2.6 chain-key straddle case, live vs. replay.
- Backfill idempotence (run twice, second touches zero rows) and the `side='target'` guard
  (a source row is never touched — assert on a fixture where the source and target lanes would
  otherwise both match `''`).
- Each `CHECK` rejects `''` for target rows and accepts it for source rows.
- **N=1 forced choice**, written explicitly as an anti-regression against re-introducing the
  optimization.
- Scopes-loading and zero-choice chooser states.

**e2e (`e2e/specs/`):** `projects/add-target-language.spec.ts` (the add-a-lane flow and its
duplicate-vs-default validation), `ai/completion-lane.spec.ts` and `ai/completion-races.spec.ts`
(lane-scoped completion), `projects/project-overview-autopilot.spec.ts` (lane sub-rows),
`projects/language-combobox.spec.ts` and `projects/project-settings.smoke.spec.ts`
(`LanguagesSection` validation), plus **every spec that opens the editor** — the chooser is a new
mandatory interstitial, so `e2e/helpers/onboarding.ts` almost certainly needs a
`chooseLane(tag)` step. Expect broad, shallow e2e churn: a one-line helper change touching most
specs.

---

## 8. Open questions

1. **The audit result.** How many projects are BLANK, and how many COLLIDE (§2.2)? Everything
   about this project's size depends on this number and nobody can answer it from the source.
   **Run slice 0's audit before committing to a schedule.**
2. **BLANK projects with real content.** A human names each lane. Who, and what happens to a
   project whose owner is unreachable — block it (unopenable), or park it in a holding state?
   Explicitly: is inventing `und` acceptable for abandoned projects with content, given it
   becomes a permanent primary-key value and a visible lane option?
3. **Linked projects.** `consumes: 'target'` links consume the upstream's default lane
   (`link-sync.ts:381`). Post-migration, which upstream lane does an existing link consume — the
   upstream's primary tag by fiat, or does each link need a human decision? Getting this wrong
   silently stops replication, and "silently" is the operative word.
4. **`chain_claims`.** Option (A) (leave keys raw, rely on the AQU-1154 CAS) or (B) (backfill
   `parent_key`)? Recommendation is (A), **contingent on the slice-0 straddle test passing.**
5. **Archiving.** Every lane becomes archivable. May a project end up with zero unarchived
   lanes — i.e. unopenable — or must at least one stay active?
6. **The scoped/unscoped switching inversion (§4.2).** Confirm it is intended that a scoped
   translator can switch among their scoped lanes while an unscoped translator at the same role
   cannot switch at all. And confirm the failure polarity: when `fetchMemberScopes` fails, offer
   the full registry (consistent with `isInMemberScope`'s fail-open) or offer nothing?
7. **Agent API / external tokens.** `select-cells.ts:206` treats `targetLang === undefined` as
   "all lanes" and `prepare.ts:430` falls back through `cmd.targetLanguage` to `''`. Does rule 2
   bind machine callers — must every lane-bearing external command name a lane — or is
   "all lanes" a legitimate agent scope? This is a **breaking API change** for external
   integrators either way; who is notified, and on what notice?
8. **Read-wall ordering (§4.1).** Confirm this project lands (at least slices 1–5) before
   read-wall slice 3, and that read-wall slice 8 does not ship `target_lang DEFAULT ''` on four
   more tables in the meantime.
9. **`MAX_TARGET_LANES`.** 50 total including the primary, or 51? The `MAX_INVITE_SCOPE_LANES`
   pin implies 50 total, which means today's dialog is already off by one.
10. **Naming.** `target_lang` and `targetLanguage` now mean nearly the same thing on a project.
    Worth renaming `settings.targetLanguage` to `primaryLane`? It is a large, purely cosmetic
    diff across a generated column, the org portfolio, and billing. Recommendation: no — but
    the doc comments must be unambiguous, because "the project's target language" will otherwise
    be read as "the default lane" for years.

## 9. Risk assessment

**Overall: large and genuinely dangerous.** Not because any single change is hard, but because
the `''` convention is a *primary-key value* in the largest table, is embedded in the immutable
event log, and is depended on by ~181 sites of which 63 fail silently. This is a data-model
migration wearing a UX ticket's clothing. Do not let the visible part — the lane chooser — set
the schedule.

**One coordinated change, or incremental?** **Incremental, but only because slice 3 makes it
safe.** Without the shim, the code-vs-backfill window is a per-cell data fork with no error, and
a flag-day would be the *safer* option despite requiring a maintenance window on a
multi-tenant system. With the shim, `''` and the real tag denote the same lane at every read,
replay, and authorization point, the ordering constraint dissolves, and each slice can ship
green. **The shim is the thing that makes the incremental plan viable; treat any proposal to
skip or defer it as a proposal to do a flag-day instead.**

Non-negotiables regardless of sequencing: slices 5 and 6 are **one operator action per project**.
A project whose `cells` migrated but whose `assignments` did not has translators assigned to a
lane that no longer exists.

**Worst realistic failure mode.** In order of expected cost:

1. **The `side = 'target'` predicate is omitted from the `cells` backfill.** Every source row in
   the system moves from `''` to a language tag, breaking the shared-source invariant, every
   source-side read (`side='source' AND target_lang=''`, ~10 sites), the source pane in every
   editor, and every AD-2 chain that pins a source head. Unrecoverable without a PITR restore,
   and it presents as "the app is blank" for all tenants at once. Mitigation: it is one `AND`
   clause — put it under review, a unit test on a fixture where source and target would both
   match, and a dry-run row-count assertion (`side='source'` rows touched must be exactly 0).
2. **A rebuild runs after the backfill without the shim.** Every historical cell reappears at
   `''` alongside its migrated twin: two rows, two chain heads, two divergent translations per
   cell, and the projection is now wrong in a way that looks like a merge conflict rather than a
   migration bug. The `CHECK` constraint converts this from silent corruption into a loud failure
   — which is precisely why slice 6 must not be deferred as "cleanup."
3. **`link-sync.ts:381` is missed.** Every `consumes: 'target'` chain silently stops replicating.
   No error, no alert. Discovered days later by a downstream team asking why their relay went
   quiet, by which time the upstream has moved on and the gap must be reconciled by hand.
4. **A COLLIDE project is auto-merged with `ON CONFLICT DO NOTHING`.** One of two real
   translations of the same language is discarded, permanently, with the event log as the only
   record. This is the argument for quarantining rather than being clever.
5. **Forced choice becomes a daily tax.** If deep links stop counting as explicit choices, or the
   chooser appears on every navigation rather than on project entry, translators hit an
   interstitial dozens of times a day and the product regresses for the people it serves. This is
   the most *likely* failure and the least severe; it is also the one that gets the change
   reverted.
