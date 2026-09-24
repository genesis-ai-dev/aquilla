# Lane read wall — inventory, enforcement point, and plumbing — Design

**Status:** Proposal for discussion · 2026-09-09
**Scope:** design + inventory only. No application source was modified producing this document.
**Builds on:** `2026-07-11-project-data-model-decision.md` (AQU-538 lanes, slices 1–5),
`2026-07-14-pm-lane-oversight-design.md` (per-lane PM surfaces), migrations 0057–0062
(`cells`/`cell_validators`/`file_section_progress` lane PKs), 0059 (`project_member_scopes`),
`sync-worker/src/events/authorize.ts` (the write wall).

**Product decision already made (not re-litigated here):** read-scoping is a **per-project
setting** and it **defaults to isolated lanes**. A lane-scoped member reads only their own
lane(s) unless the project opts out.

---

## 0. The shape of the problem, in one paragraph

Writes have one door. `authorize()` is the only function that mints an `AuthorizedEvent`, an
ESLint `no-restricted-syntax` rule plus a private `Symbol` brand make bypass a compile/lint
error, and so AQU-553's write wall needed exactly one `SCOPE_GATED_KINDS` set in one file.
Reads have **no** such door: every read route independently calls one of the three verifiers in
`sync-worker/src/auth.ts`, then writes its own SQL. `verifyTokenForProject` returns claims and
nothing else, so **nothing in the type system knows a read has a lane obligation.** The
inventory below found **41 read paths that carry lane-bearing data to a client, 34 of which
apply no lane restriction whatsoever.** The recommendation in §2 is therefore as much about
manufacturing a door as it is about picking one.

Second structural fact worth stating up front: `cells`, `cell_validators`,
`file_section_progress`, and `assignments` carry `target_lang`. **`cell_audio`,
`cell_backtranslations`, `cell_waivers`, and `cell_links` do not, and neither does `events`**
(where the lane lives inside `payload` JSON). No enforcement layer can filter a column that
does not exist, so those five tables are a separate, more expensive workstream (slices 8–9),
not a rounding error on the main one.

---

## 1. Inventory of unscoped lane-bearing read paths

Legend for **Lane filter feasible here?**
- **Yes** — the queried table has `target_lang`; adding a predicate is mechanical.
- **Yes, param exists** — the route already accepts `?lane=`, but it is *client-supplied and
  advisory*. The fix is to stop trusting the client, not to add a column.
- **Schema** — the table has no lane column; needs a migration or a derived join first.
- **Payload** — the lane is inside `events.payload` JSON; needs a generated column or a JSON
  predicate.
- **No** — not lane-addressable at all; enforcement must happen somewhere else.

### 1.1 sync-worker — cell/text reads

| # | File | Function / route | Returns | Lane today | Feasible? |
|---|---|---|---|---|---|
| 1 | `events/cells-read-route.ts` | `handleCellsReadRequest` — `GET /api/v1/projects/:p/files/:f/cells` | Full cell rows both sides, all lanes: `value`, `valueHtml`, `validated`, `aiDraft`, editor identity. Paginated, delta (`?since=`), and `cellIds=` fast paths | `?lane=` optional, client-chosen; absent = **all lanes** | Yes, param exists |
| 2 | `events/cells-read-route.ts` | same route, `?since=` delta branch | `changedCellIds` is computed from `events` with **no** lane predicate, so out-of-lane cell ids leak even when the rows are filtered | none | Payload |
| 3 | `events/cells-audit-read-route.ts` | `handleCellsAuditReadRequest` | `cells` content hashes + `cell_validators` + `cell_waivers` for a file/cell | none | Yes (cells, validators) / Schema (waivers) |
| 4 | `events/validators-read-route.ts` | `handleValidatorsReadRequest` | Who validated a cell, per lane, with usernames | `?lane=` optional; absent = **all lanes** | Yes, param exists |
| 5 | `events/cell-history-read-route.ts` | `handleCellHistoryReadRequest` | Every event for one cell incl. full `target.cell.commit` payloads (i.e. other lanes' text) | none | Payload |
| 6 | `events/read-route.ts` | `handleEventsReadRequest` — `GET /events?fileId=` | Raw event log for a file, all kinds, all lanes, payloads included. **The single broadest leak in the system** | none | Payload |
| 7 | `events/member-activity-read-route.ts` | `handleMemberActivityReadRequest` | Per-author activity from `events` JOIN `cells` | none | Payload / Yes |
| 8 | `events/cell-backtranslations-read-route.ts` | `handleCellBacktranslationsReadRequest` | Latest back-translation per cell — English gloss of a lane's translation | none; table has no `target_lang` | Schema (derivable via `target_event_id`) |
| 9 | `events/cell-audio-read-route.ts` | `handleCellAudioReadRequest` | Audio attachments per cell incl. R2 URLs and transcriptions | none; table has no `target_lang` | Schema |
| 10 | `events/cell-links-read-route.ts` | `handleCellLinksReadRequest` | `cell_links` graph | none; no `target_lang` | Schema |
| 11 | `events/cell-confidence-route.ts` | `handleCellConfidenceRequest` | Confidence/health propagated over neighbours | takes a lane arg | Yes |
| 12 | `events/stale-source-route.ts` | `handleStaleSourceRequest` | Which target cells are stale against source | takes a lane arg | Yes |

### 1.2 sync-worker — search, progress, export, rollups

| # | File | Function / route | Returns | Lane today | Feasible? |
|---|---|---|---|---|---|
| 13 | `events/scoped-search.ts` | `queryScopedSearch` | Project-wide FTS over `cells`: `value` + `<mark>` snippet for **every lane's** target rows | none (only `side`) | Yes |
| 14 | `events/scoped-search.ts` | `queryScopedExact` | Same, exact-phrase, plus the paired opposite-side value | none | Yes |
| 15 | `events/scoped-search.ts` | `querySourceNeighbors` | Validated translated neighbours for few-shot | partial | Yes |
| 16 | `events/scoped-search.ts` | `queryFileSourceNeighbors` | Same, file-scoped — **already lane-scoped** (AQU-1005) | lane arg, enforced | Yes ✅ |
| 17 | `events/search-route.ts` | `handleSearchReadRequest`, `handleSearchPassagesRequest` | HTTP surface for #13/#14 | none | Yes |
| 18 | `events/branching-search-route.ts` | `handleBranchingSearchRequest` | Corpus-driven branching search results | partial | Yes |
| 19 | `events/branching-search-passages-route.ts` | `handleBranchingSearchPassagesRequest` | Passage results with paired values | partial | Yes |
| 20 | `lib/branching-search/corpus.ts` | corpus assembly | Cell values feeding #18/#19 | partial | Yes |
| 21 | `events/progress-read-route.ts` | `handleProgressReadRequest` | File + section progress counts | `?lane=` defaults to `''` — so a member scoped to `es` reads the **default lane's** progress by default | Yes, param exists |
| 22 | `events/files-read-route.ts` | `handleFilesReadRequest` | File listing; joins `file_section_progress` at `target_lang = ''`; `files` scalar counters are cross-lane sums by design | hardcoded `''` | Yes (join) / No (`files` counters) |
| 23 | `events/health-rollup-route.ts` | `handleHealthRollupRequest` | Project-wide health with neighbour retrieval | `?lane=` defaults `''` | Yes, param exists |
| 24 | `events/export-route.ts` | `handleExportSourceRequest` | **Full text export of a lane**, USFM/plain | `?lane=` defaults `''`, client-chosen | Yes, param exists |
| 25 | `events/export-bundle-route.ts` | `handleExportBundleRequest` | Multi-file export bundle | `?lane=` defaults `''`, client-chosen | Yes, param exists |
| 26 | `events/plan-route.ts` | `handlePlanRequest` | Plan units | lane-aware | Yes |
| 27 | `events/import-reconcile-route.ts` | `handleImportReconcileRequest` | Reconcile diff incl. existing lane content | lane-aware-ish | Yes |
| 28 | `events/concepts-read-route.ts` | `handleConceptsReadRequest` | Project concepts | not lane-addressable | No |
| 29 | `events/comments-read-route.ts` | `handleCommentsReadRequest` | Comments (project + counts) | not lane-addressable; write wall deliberately never gates comments | No — see §4.7 |

### 1.3 sync-worker — realtime / Durable Object

| # | File | Path | Returns | Lane today | Feasible? |
|---|---|---|---|---|---|
| 30 | `project-do-handlers.ts` | `ServerEventApplied.rows` | Doc comment says it plainly: *"The cell's CURRENT projected rows (both sides, **all lanes**)"*, serialized like the by-ids read and pushed to **every** connected socket on the project | none | Yes, but not at the SQL layer — see §2.4 |
| 31 | `project-do.ts` | `broadcastToAll` | One pre-built frame fanned to all connections; `ConnectionState` carries `userId`/`role` but **no lane set** | none | Requires DO change |
| 32 | `project-do-handlers.ts` | `ServerPresenceDraft.draftText` | Live remote-caret draft text for a cell, unfiltered | none | Requires DO change |
| 33 | `project-do.ts` | `/connect` handshake | Lane set would have to be captured here; role is already captured once and cached for the socket's life | n/a | Requires DO change |

### 1.4 sync-worker — external / Agent API

| # | File | Function | Returns | Lane today | Feasible? |
|---|---|---|---|---|---|
| 34 | `external/read-routes.ts` | `handleExternalReadRequest` | Delegates to the internal reads incl. their `lane=` passthrough | client-supplied | Yes, param exists |
| 35 | `external/mcp-handlers.ts` / `mcp-tools.ts` | MCP read tools | Cell/lane data to an LLM agent | client-supplied | Yes |
| 36 | `external/discovery-route.ts` | discovery | Advertises `targetLanes` registry | none | Yes |

### 1.5 auth-worker

| # | File | Function / route | Returns | Lane today | Feasible? |
|---|---|---|---|---|---|
| 37 | `services/assignments.ts` | `getOrgAssignmentWorkload` | Org-wide assignment rows **with `target_lang`** and assignee identity | none | Yes |
| 38 | `services/assignments.ts` | `getProjectAssignmentRoster` | Per-assignee workload + progress for a project, all lanes | none | Yes |
| 39 | `services/assignments.ts` | `getMyAssignments`, `getMyAssignmentsAcrossOrg` | Caller's own assignments with lanes (self-scoped, so lower risk) | none | Yes |
| 40 | `services/assignments.ts` | `getFileChapters` | `cells` read for chapter list | none | Yes |
| 41 | `services/org-permissions.ts` | `fetchPortfolioLanes`, `getOrgPortfolio`, `getOrgPortfolios` | **Per-lane** totals/filled/validated/last-edit for every project in the org, plus the registered-lane union | none | Yes |
| 42 | `routes/contextual.ts` | `GET /:p/contextual/drafts`, `/runs`, `/segmentation` | Staged AI drafts and run state for a **client-supplied `?targetLang=`**, VIEWER floor | client-supplied | Yes |
| 43 | `lib/agent/tools/select-cells.ts` | `selectCellPairs` | Source/target pairs; `scope.targetLang === undefined` ⇒ **all lanes** | optional | Yes |
| 44 | `lib/contextual/project-context.ts` | project context assembly | Lane registry + languages into agent prompts | partial | Yes |
| 45 | `lib/changeset-approval-changes.ts` | changeset diff rendering | Proposed changes with `target_lang` | none | Yes |
| 46 | `routes/merge-sibling.ts` | merge-sibling | Donor default-lane content folded into a host lane | lead-gated both sides | n/a |
| 47 | `routes/projects.ts` | project GET/PATCH | `settings.targetLanes` registry (lane *names*, not content) | none | Yes — see §4.8 |

### 1.6 Frontend bulk receipt / caches

| # | File | What | Leak after a scope change |
|---|---|---|---|
| 48 | `src/lib/sync/cells-cache.ts` | IDB `aquilla-cells-cache`, key `${accountOwner}:${projectId}:${fileId}` — **not lane- or scope-keyed** | A full-lane snapshot fetched before scopes tightened persists indefinitely and is re-hydrated on boot |
| 49 | `src/lib/progress/file-progress-resource.ts` | IDB progress cache; key gained the lane in AQU-538 | Stale cross-lane progress until the ETag misses |
| 50 | `src/lib/store/project-index.ts` | IDB project index | Lane registry names |
| 51 | `src/hooks/useCells.ts`, `useActiveCellStore` | Filter target rows to `activeLane` **client-side only** | Cosmetic filter over data the client already holds — this is the reason a server-side wall is required at all |

**Totals: 51 paths inventoried. 41 carry lane-bearing content or lane-derived aggregates to a
client. 34 apply no lane restriction of any kind** (the remainder either accept a
client-advisory `?lane=` that is trivially overridden, or are already enforced — #16 only).

---

## 2. Where the read wall belongs

### 2.1 The four candidate layers

**SQL layer (Postgres RLS).** Rejected. The workers connect through Hyperdrive with a shared
pooled role and never establish a per-user session, so there is no `SET LOCAL app.user_id` to
hang a policy on; adding one means a per-request round-trip on the hottest path in the system.
RLS also cannot express the wall for `cell_audio`, `cell_backtranslations`, `cell_waivers`,
`cell_links`, or `events`, because the lane is not a column there. And a policy that silently
returns fewer rows is a debugging nightmare in a system whose projections are already
delta-and-ETag-sensitive: #1's chain walk would start producing different orderings with no
visible cause.

**Route boundary.** Rejected as the *primary* layer. It is 30+ independent edit sites with no
compile-time guarantee, and — decisively — it cannot cover paths #30–33, because the DO
broadcast is not a route.

**Shared repository layer.** Attractive but does not exist. There is no cell repository; each
route hand-writes SQL against `cells`. Creating one is a larger refactor than the wall itself
and would have to land before any enforcement, which violates the "small, independently
shippable" requirement.

**Sync/snapshot layer.** Necessary but insufficient. #1 is the bulk of the exposure by volume,
but #6 (`GET /events`), #13/#14 (FTS), #24/#25 (export), #30 (realtime rows), and #41
(portfolio) are all independent egress channels a client can reach directly.

### 2.2 Recommendation: one *authority*, two *enforcement points*, one *brand*

Copy the write wall's architecture rather than its location.

**The authority (one file, the choke point for the decision).** A new
`sync-worker/src/events/lane-read-authority.ts`, modelled exactly on the existing
`timing-authority.ts` / `line-creation-authority.ts` pattern:

```ts
/** null = unrestricted (all lanes). A Set may legitimately contain ''. */
export type ReadLanes = ReadonlySet<string> | null

export async function resolveReadLanes(
  claims: SyncTokenClaims,
  db: AquillaDb | undefined,
  cache?: RequestCache,
): Promise<ReadLanes>
```

Every read path asks this one function "which lanes may this caller read?" It composes the
JWT `scopes` claim, the role floor, the `src` claim, and the new per-project setting (§3). It
reuses `makeRequestCache(db).projectSettings(projectId)`, so a batch pays one settings read.
An absent `db` returns `null` — same fail-open-to-current-behaviour convention every other
authority helper in that directory uses, which is what keeps existing tests passing.

**Enforcement point A — the SQL predicate helper.** A second export in the same file:

```ts
/** Appends `AND (side = 'source' OR target_lang IN (...))`, or nothing when unrestricted. */
export function laneReadPredicate(lanes: ReadLanes, col = 'target_lang'):
  { sql: string; binds: string[] }
```

Source rows are **always** included: the shared-source invariant from the AQU-538 decision
("Source rows are always lane `''`… the source exists once, shared by all lanes"). #1 already
has precisely this predicate shape — `AND (side = 'source' OR target_lang = ?)` — so slices 3
and 4 are largely "replace a client-supplied bind with the resolved set."

**Enforcement point B — the DO connection.** `ConnectionState` in `project-do.ts` gains
`readLanes`, resolved at `/connect` alongside `role`, and `broadcastToAll` becomes
lane-aware for the two frames that carry content (`event.applied.rows`, `presence.draft`).
This is a genuinely separate mechanism and it is why the answer is "smallest set," not "one."

**The brand (how we stop this regressing).** `scoped-search.ts` already establishes the
idiom: `VerifiedProjectId = string & { __brand: 'verified-project-id' }`, minted only by
`makeVerifiedProjectId(claims)`, so a query cannot be written against an unverified project
id. Extend it:

```ts
export type LaneScopedRead = { project: VerifiedProjectId; lanes: ReadLanes }
```

Have the lane-bearing query helpers take `LaneScopedRead` instead of `VerifiedProjectId`, add
an ESLint `no-restricted-syntax` entry for the mint site mirroring the `AuthorizedEvent` rules
already in `eslint.config.js`, and a new lane-bearing read becomes *awkward to write wrongly*
rather than merely *reviewed carefully*. This is the single highest-leverage item in the whole
design: it is what makes slice 4 mechanical and slice 12 (future routes) free.

### 2.3 Why not put the lane set in the verifiers

Tempting — all 30-odd routes already call `verifyTokenForProject`/`ForFile`/`ForDoc`, so
returning `readLanes` from them would reach every caller in one edit. Rejected because those
three functions are deliberately **pure and binding-free** ("Kept dependency-free from Durable
Object / worker bindings so it can be unit-tested directly") and are shared with the write
path via `authorize()`. Threading a `db` handle into them to read `project_settings` would
couple the JWT verifier to the database and change the write wall's contract as a side effect
of a read feature. Keep them pure; call `resolveReadLanes(auth.claims, env.AQUILLA_PG, cache)`
on the line after.

### 2.4 Where enforcement is explicitly NOT possible at the recommended layer

| Path | Why the authority + SQL predicate cannot cover it | Separate fix |
|---|---|---|
| #30–33 realtime / DO | Not a route; one frame is pre-built and fanned to all sockets; the DO holds no db handle at broadcast time | Enforcement point B (slice 5) — resolve at handshake, filter per connection |
| #8 back-translations, #9 audio, #10 cell links, #3 waivers | `cell_backtranslations`, `cell_audio`, `cell_links`, `cell_waivers` have **no `target_lang` column** | Slice 8: migrations + projection writes + backfill to `''` |
| #2, #5, #6, #7 event-log reads | Lane lives in `events.payload` JSON; `events` has no lane column | Slice 9: generated column or JSON predicate on the hot write table |
| #22 `files` scalar counters | Cross-lane sums *by design* per the AQU-538 slice-1 note | Product decision, not a filter (§4.9) |
| #37–47 auth-worker | Different worker; does not verify sync tokens and has no `RequestCache`; reads `project_member_scopes` directly | Slice 7: a parallel resolver in `auth-worker/src/services/` |
| #48–51 client caches | Server-side filtering does not evict bytes already on the user's disk | Slice 6: a `scopesVersion` cache-identity component |
| #29 comments | Not lane-addressable; the write wall deliberately exempts comments | Product decision (§4.7) |

---

## 3. Plumbing the per-project setting

### 3.1 Name and location

**`laneReadIsolation: 'isolated' | 'open'`**, in the `project_settings.settings` JSON blob.

Naming rationale: it says what it controls (reads), what dimension (lanes), and its two states
are self-describing in a settings UI. It deliberately does **not** reuse the `allow*` prefix of
`allowLineCreation` / `allowSelfAssignment` / `allowTrackEditing`, because those all default to
*off/permissive-when-absent* and this one defaults to *restrictive-when-absent* — a reader who
pattern-matches the prefix would get the polarity backwards. The closest existing precedent for
the polarity is `timingLocked`, which carries an explicit "ABSENT MEANS LOCKED" comment in
`src/lib/parsers/types.ts`; this setting gets the same treatment.

Schema: no new table and no data migration. One generated column, following the exact precedent
of migration 0054 and the AQU-575 `target_lanes` / `validation_count` projections:

```sql
-- Migration 00NN: read-side lane isolation projection.
ALTER TABLE project_settings
  ADD COLUMN lane_read_isolation TEXT
  GENERATED ALWAYS AS ((settings::jsonb)->>'laneReadIsolation') STORED;
```

The generated column exists for the same reason the others do — the schema comment is blunt
about it: *"settings blobs run to multiple MB; reads must use these columns, never
`(settings::jsonb)->>'…'` inline (org-dashboard timeout)."* The org-portfolio path (#41) needs
the setting for **every project in the org** in one query; without the column that is the
exact shape of query that already timed out once.

### 3.2 Defaulting to isolated without breaking existing projects

`NULL` / absent / any unrecognised value ⇒ **`'isolated'`**. There is no backfill, so:

- Every existing project is isolated the moment the code ships, which is the decision.
- The generated column is `NULL` for all existing rows — free, no table rewrite of the blob.
- Nothing breaks, because *isolation only bites members who have lane scope rows*, and those
  members were already write-restricted to exactly those lanes. Isolation makes their read
  surface match their write surface. Unscoped members (the overwhelming majority — every
  member of every N=1 project) are unaffected; see §4.3.
- A project that genuinely wants cross-lane visibility writes `'open'` through the ordinary
  `PATCH` project-settings path (maintainer 600+, same floor as `targetLanes`).

Parse it with a fail-closed helper, so a typo or a partially-written blob isolates rather than
opens:

```ts
export function resolveLaneReadIsolation(settings: Record<string, unknown> | null): boolean {
  return settings?.laneReadIsolation !== 'open' // absent, null, garbage ⇒ isolated
}
```

### 3.3 How it reaches the enforcement point

**sync-worker (points A and B):** `RequestCache.projectSettings(projectId)` already exists and
is already threaded through the events route; the read routes construct one per request the
same way. `resolveReadLanes` consumes it. One memoized read per request regardless of how many
queries the route runs.

**Deliberately NOT in the JWT.** Sync tokens live 15 minutes. If the setting rode the token, a
lead flipping a project to `'isolated'` would leave every warm client reading cross-lane for up
to 15 more minutes — the exact window an operator flipping that switch is trying to close. The
setting is one memoized indexed read; pay it.

**auth-worker (slice 7):** reads `lane_read_isolation` and `project_member_scopes` directly.
`member-scopes.ts` already has a `loadScopes(env, projectId, userId)` helper that generalises
into the resolver with no new query shape.

**DO (point B):** resolved once at `/connect` and stored on `ConnectionState`, mirroring how
`role` is handled. There is already a `POST /__member-role-changed` hook that updates a live
connection's cached role in place — scope changes should ride the same hook (renamed or
extended) so a scope tightening does not wait for the socket to reconnect.

### 3.4 Interaction with the existing JWT scope claims

The `scopes` claim does **not change shape, meaning, or mint logic.** It stays the write wall's
input, minted by `signSyncTokenWithRole` and omitted entirely when unscoped. The read wall is a
*second consumer* of the same claim, and the resolution order matters:

```
resolveReadLanes(claims, db, cache):
  1. claims.src === 'platform'            -> null   (all lanes; ADMIN_EMAILS operator path,
                                                     same exemption the write path grants)
  2. claims.role >= ROLE.PROJECT_LEAD     -> null   (500+; leads/maintainers/owners/PMs.
                                                     Already unscopable by rule — member-scopes.ts
                                                     PUT rejects scoping anyone >= 500)
  3. laneReadIsolation !== 'isolated'     -> null   (project opted out)
  4. lane scopes present in claims.scopes -> Set(values)   ('' is a legitimate member)
  5. otherwise (no lane scopes)           -> null   (unscoped member; see §4.3)
```

Two properties worth naming. First, the check is **cheap in the common case**: steps 1 and 2
short-circuit before any DB read, so the PM and lead traffic that dominates the dashboard
surfaces never touches `project_settings`. Second, `file` scopes are **not** part of this
resolution. They are a separate dimension that composes with AND on the write side, and
extending the read wall to file scopes is a coherent follow-up but is out of scope here —
noted as open question 8.

---

## 4. Edge cases

### 4.1 The empty-string default lane — the single most likely source of bugs

`''` is falsy. Every idiom that reaches for truthiness is wrong, and **there is already a live
instance of exactly this bug** in the highest-traffic read path. `cells-read-route.ts`:

```ts
const laneFilter = qLane && qLane.length > 0 ? qLane : null   // '' collapses to "all lanes"
```

A member scoped to the default lane who requests `?lane=` gets *every* lane. Today that is
harmless (the param is advisory anyway); the moment it feeds the wall it is a bypass. The
param must become **tri-state**: absent (no client preference), present-and-empty (the default
lane), present-with-value. The same care applies to:

- `laneReadPredicate` — always `lanes.has(row.target_lang ?? '')`, never `if (lane)`.
- `project_member_scopes` rows storing `''` — the schema comment already says *"default lane
  stored as literal `''`"*; the `PUT` route's zod schema is `z.string()` with **no** `.min(1)`,
  so `''` is accepted today. Good; keep it, and add a test pinning it.
- SQL binds — `target_lang IN ('')` is correct and must not be optimised into `IS NULL`; the
  column is `TEXT NOT NULL DEFAULT ''`.
- ETag composition — a lane set of `{''}` and a lane set of `null` must produce **different**
  ETags (§4.10).

### 4.2 Owners / admins / PMs must see everything

Handled by steps 1–2 of §3.4, and the invariant is already enforced upstream:
`member-scopes.ts` `PUT` returns 400 for any target whose effective role is ≥ 500 ("scopes are
for contributor/reviewer roles"), and `signSyncTokenWithRole` omits the claim when there are no
rows. So a lead's token structurally cannot carry lane scopes. Belt and braces: keep the
explicit `role >= PROJECT_LEAD` short-circuit in the resolver anyway, so a hand-crafted or
legacy token with both a lead role and stale scope rows still reads everything.

PM surfaces specifically: the whole point of `2026-07-14-pm-lane-oversight-design.md` is that
the portfolio (#41), the ProjectOverview lane table, and the members matrix show **all** lanes.
Slice 7 must not regress those. Since PMs sit at ≥ 500, step 2 covers them — but the
portfolio query is org-scoped and resolves roles per project, so slice 7 needs a per-project
lane set inside one org-wide query rather than a single answer. That is the risky part of
slice 7 and is called out as such.

### 4.3 Unscoped members — what "no rows" means, and what it should mean

**Today it means "all lanes."** Definitively: `signSyncTokenWithRole` omits the `scopes` claim
when `scopeRows` is empty; `authorize()` gates on
`Array.isArray(tokenClaims.scopes) && tokenClaims.scopes.length > 0`; the schema comment says
*"No rows for a (project,user) pair = unscoped = today's behavior"*; and the AQU-538 slice-5
note says *"no rows = unscoped = exactly today."*

**It should keep meaning "all lanes," and this is a deliberate, load-bearing choice that
deserves defending**, because it looks like it contradicts "default to isolated." It does not.
The setting governs *how scopes are enforced*, not *whether scopes exist*. Reading "isolated"
as "invent a default-lane-only scope for anyone who has none" would mean:

- every member of every existing N=1 project — where the only lane is `''` — is suddenly
  restricted to `''`, which is a no-op there, but
- every member of a multi-lane project who was never scoped loses access to every non-default
  lane on deploy, with no admin action and no audit trail explaining it, and
- the "isolated" default would become a silent mass permission change rather than a tightening
  of an existing, deliberately-granted restriction.

That said, "unscoped sub-lead members see only the default lane" is a *coherent* product
position for a locked-down deployment, and it is the kind of thing a diode-zone partner might
ask for. Recommendation: ship isolation as scoped-only, and if the appetite exists, add a
**third** setting value `'strict'` later meaning "sub-lead members with no lane scope read the
default lane only." Open question 1.

### 4.4 Linked / mirrored projects

Three distinct concerns in `link-sync.ts`, and they pull in different directions:

**The mirror engine must not inherit a user's lane set.** `link-sync.ts` runs server-side
under `SYNC_SECRET_KEY` service auth, reading the *upstream* project's rows to fold into the
downstream. If it were routed through `resolveReadLanes` with a caller's claims, a scoped user
triggering a lazy pull would silently produce a partial mirror — silent data loss, far worse
than the leak being fixed. **Service-authenticated paths must be explicitly exempt**, and the
exemption needs a test, because it is the failure mode a well-meaning slice-4 sweep would
introduce.

**v1 target-consumption already pins the default lane.** `foldTargetLaneDelta` skips commits
where `payload.targetLang !== ''` — *"v1 target-consumption links consume the upstream's
DEFAULT lane only."* So chains do not currently fan out across lanes, and the read wall does
not need to teach them to.

**Chains are a legitimate cross-project read channel, and it should be documented rather than
closed.** In a chain (`consumes: 'target'`), the downstream project's **source** lane *is* the
upstream's translation. Source rows are never scope-gated — by explicit AQU-538 invariant — so
a user excluded from lane `fr` on the upstream project who is a member of the downstream
Chaluba project reads that French text as source. That is correct and intended (it is the
entire purpose of a relay), but it means **lane isolation is not a confidentiality boundary
across a link edge.** If someone is relying on lane scopes to keep a lane's content from a
person, and that person is on a downstream chain, the scope does not hold. This belongs in the
settings UI copy, not just in a spec.

**Sibling-merge.** `merge-sibling` requires project_lead 500+ on **both** sides, and folds a
donor's default lane into a new host lane through the front door. Post-merge, the host lane's
content is readable by whoever is scoped to that host lane — correct. No read-wall change; note
only that the donor's archived event log stays intact as provenance and remains reachable via
#6 (`GET /events`) for anyone with a token on the donor project.

### 4.5 Client-side caches that leak after a scope change

`cells-cache.ts` keys on `${accountOwner}:${projectId}:${fileId}` and stores the **merged
all-lane row set**. Nothing in that key changes when a lead tightens a member's scopes, so the
pre-tightening snapshot survives on disk and is re-hydrated on the next boot — a server-side
wall alone does not close this.

Recommended fix, smallest version that actually works: mint a **`scopesVersion`** into the sync
token — a short hash over `(sorted scope rows, laneReadIsolation, role)` computed in
`signSyncTokenWithRole`, which already loads the scope rows and would only need the setting.
The client folds it into the IDB cache key and purges non-matching entries on hydrate. Same
treatment for `file-progress-resource`'s IDB key and any React Query keys holding cell rows.

Two adjacent leaks in the same family: the **isolate-local `chainCache`** in
`cells-read-route.ts` is keyed on `(projectId, etag, side, laneFilter)` where `laneFilter` is
*client-supplied* — once the wall computes the effective set, that key must use the **effective
lane set**, or one user's cached chain ordering is served to another user with different
scopes, across users, inside a shared Worker isolate. And any intermediary cache keyed on the
ETag alone has the same problem (§4.10). The `chainCache` one is a **cross-user** leak and
should be treated as the highest-severity item in slice 3.

### 4.6 Delta reads leak cell *ids* even when rows are filtered

The `?since=` branch computes `changedCellIds` straight from `events` with no lane predicate,
then filters only the returned rows. A scoped member therefore learns which cells another lane
touched and when. Ids and timing only, no content — genuinely low severity, but it is a
side-channel that will be reported as a bug once the wall exists, and it cannot be fixed
without slice 9 (the lane is in the payload). Decide deliberately: accept and document, or
defer to slice 9.

### 4.7 Comments, audio, and the write wall's exemption list

`authorize()`'s `SCOPE_GATED_KINDS` is deliberately narrow, with a documented rationale:
*"source-side cell events, comments, audio, waivers, back-translations, assignments, file-level
lifecycle… are NEVER scope-gated: source rows are shared across lanes, and the other surfaces
aren't lane-addressable."* For **writes** that reasoning holds. For **reads** it partially
fails: a comment thread on a cell frequently quotes the lane's translation, and audio (#9) is
a recording *of* a lane's text. So the write wall's exemption list is not automatically the
read wall's exemption list. Recommendation: gate audio and back-translations once they have a
lane column (slice 8), and leave comments ungated in v1 while making the gap explicit in the
settings copy. Open question 5.

### 4.8 Lane *names* versus lane *content*

`settings.targetLanes` (#47, #36) is the lane registry — tags, not text. Under isolation,
should a member scoped to `es` learn that `fr` and `sw` lanes exist? Hiding it breaks the
`LaneSwitcher`, the `?lane=` deep-link resolver, and archived-lane handling, all of which read
the registry from `useProject`'s settings overlay. Recommendation: **lane names stay visible**
in v1 (registry ≠ content), which also keeps the client simple. Flag it — some partners will
consider the existence of a language a disclosure. Open question 6.

### 4.9 Cross-lane aggregates

Three rollups are knowingly lane-blind, and the AQU-538 slice-1 note already lists them:
`files` scalar counters sum across lanes, and `file_section_progress` aggregates. Under
isolation, a scoped member reading a cross-lane sum can infer other lanes' progress
(differencing their own lane out). This is inference from an aggregate, not disclosure of
content. Recommendation: leave the sums alone in v1; if a partner objects, the fix is to serve
scoped members the lane-scoped rollup rather than the sum, which #21/#22 can already do.

### 4.10 ETags, 304s, and shared caches

`cells-read-route`'s ETag is `"<fileId>:<epoch>:<rebuiltSeq>:<maxSeq>"` — **no lane, no
identity.** Two callers with different lane sets compute the same ETag for different response
bodies. Responses are `private, no-cache`, so a well-behaved browser is safe, but: (a) the
isolate-local `chainCache` keys off this string (§4.5), (b) a scope change does not invalidate
a client's stored validator, so a member whose scopes just shrank can be served a `304` against
their own full-lane cached body. **The ETag must gain a lane-set component** (and `{''}` must
hash differently from `null`). Same for `progress-read-route`'s lane-suffixed ETag, which
already has the right shape — it appends `:lane:<tag>` only for non-default lanes, so under the
wall the default-lane and unrestricted cases would collide.

---

## 5. Sliced implementation plan

Sizes: **S** ≈ under a day, **M** ≈ 1–3 days, **L** ≈ a week+. Each slice is independently
shippable and independently testable; each ends green with no behaviour change beyond its own.

| # | Slice | Size | Risk | Depends on |
|---|---|---|---|---|
| 0 | **Characterisation tests.** Fixture: project with lanes `''`+`es`, a contributor scoped to `es`, a lead. Assert *today's* leaky behaviour explicitly across #1, #6, #13, #24, #30, #41. Pins the baseline and becomes the diff every later slice reads against. No production code. | S | — | — |
| 1 | **Setting + authority, unwired.** `laneReadIsolation` in the `ProjectSettings` type with the `timingLocked`-style polarity comment; the generated-column migration; `lane-read-authority.ts` with `resolveReadLanes` + `laneReadPredicate` + `resolveLaneReadIsolation`; unit tests incl. the `''` cases from §4.1. Nothing calls it yet. Zero behaviour change. | S | Low | 0 |
| 2 | **`LaneScopedRead` brand + ESLint guard.** Extend the `VerifiedProjectId` idiom; add the `no-restricted-syntax` entries next to the `AuthorizedEvent` ones. Still unwired. | S | Low | 1 |
| 3 | **`cells-read-route` — the 80% slice.** Wire the resolver. Fix the `''` tri-state param bug. Fold the effective lane set into the ETag **and** the `chainCache` key (§4.5 — cross-user). Handle the delta branch. | M | **HIGH** | 1, 2 |
| 4 | **Remaining lane-column reads.** #4, #21, #22, #23, #24, #25, #11, #12, #13–#20, #26, #27. Mechanical once 2 and 3 land; the brand makes each a compile error until fixed. Split into 2–3 PRs by surface (search / export / progress). | M | Med | 3 |
| 5 | **Realtime + DO.** `ConnectionState.readLanes` at `/connect`; per-connection filtering of `event.applied.rows` and `presence.draft`; extend `/__member-role-changed` to carry scope changes. | M | **HIGH** | 1 |
| 6 | **Client cache identity.** `scopesVersion` claim in `signSyncTokenWithRole`; fold into `cells-cache` and `file-progress-resource` IDB keys; purge on mismatch. | S | Med | 1 |
| 7 | **auth-worker read wall.** Parallel resolver over `project_member_scopes` + `lane_read_isolation`; apply to #37–#45. The org-portfolio per-project lane set inside one org-wide query is the hard part. | M | Med | 1 |
| 8 | **Lane columns for the lane-less tables.** Migrations adding `target_lang` to `cell_audio`, `cell_backtranslations`, `cell_waivers`, `cell_links`, defaulting `''`; projection writes in `event-projection.ts`; backfill; then wire #3, #8, #9, #10. | L | **HIGH** | 4 |
| 9 | **Event-log reads.** #2, #5, #6, #7. Needs a lane discriminator on `events` (generated column from `payload->>'targetLang'`, or a JSON predicate) on the hottest write table in the system. | M | **HIGH** | 4 |
| 10 | **External / Agent API.** #34–#36 via the same resolver; decide an agent token's lane set (open question 7). | S | Med | 4 |
| 11 | **Settings UI + copy.** The toggle (maintainer 600+, same floor as `targetLanes`); a "you are seeing only <lane>" affordance; copy stating the chain-link caveat (§4.4) and the comments gap (§4.7). | S | Low | 3 |

**Riskiest slices and why.**

- **3** — touches the highest-traffic route in the app, and the ETag/`chainCache`/delta triangle
  is where a mistake becomes a *cross-user* leak inside a shared isolate rather than merely a
  failure to filter. Land it alone, with the §4.5 cache-key test as the acceptance gate.
- **5** — changes broadcast from one pre-built frame to per-connection serialization, so it is a
  fan-out performance change as well as a security change; and the handshake-cached lane set
  inherits the documented staleness window that `ConnectionState.role` already has.
- **8** — migrations plus projection writes plus backfill on four tables; the only slice that
  touches the write path, where a mistake corrupts data rather than leaking it.
- **9** — a generated column on `events` is a schema change on the hot write path of an
  event-sourced system; measure before committing to it.

---

## 6. Reconciliation with the prior specs

**`2026-07-11-project-data-model-decision.md`** — nothing here contradicts it, and two of its
invariants are load-bearing for this design:

- *"Source rows are always lane `''`. The source exists once, shared by all lanes"* ⇒
  `laneReadPredicate` **must** pass source rows unconditionally. A wall that filtered source
  rows by lane would break every scoped member's editor, since the source pane is the left half
  of the screen.
- *"`''` is the default lane… clients omit `''` on the wire so default-lane events stay
  byte-identical"* ⇒ the wire convention that omits `''` is exactly what makes §4.1 dangerous.
  Absent-means-default on the write path meets absent-means-all-lanes on the read path, and the
  tri-state param is the reconciliation.
- Slice 5's closing instruction — *"If you add a new target-side event kind, decide explicitly
  whether it's scope-gated and add it to the authorize matrix + tests"* — gets a read-side twin:
  *if you add a new lane-bearing read, take a `LaneScopedRead`.* Slice 2 makes that mechanical
  rather than cultural.

**`2026-07-14-pm-lane-oversight-design.md`** — this is where the tension lives, and it is
resolved by role, not by exception. Every surface that spec shipped is explicitly cross-lane:
the OrgHome language grid, the ProjectOverview lane table, `PortfolioProject.lanes[]`, the
members matrix with lane-scope chips. All of them are PM surfaces, and PMs sit at ≥ 500, so
§3.4 step 2 hands them `null` before any settings read. Two specifics:

- That spec noted the per-file drill-down *"silently default-lane (today's behavior — a real PM
  trap once N>1 exists)"* and fixed it by threading `?lane=`. The read wall must not undo that:
  a lead's explicit `?lane=fr` still wins, because their lane set is `null`.
- Its §3.4 already codifies "Leads/maintainers are added unscoped… the UI says 'leads see all
  languages'." The read wall makes that sentence *true of reads as well as writes*, which is
  strictly a consistency improvement over shipping isolation without it.

**`2026-08-18-oversight-command-registry-addendum.md`** (adjacent) — the agent harness mints
project-scoped tokens through `signSyncTokenWithRole`, so agent reads inherit whatever lane set
that user has. Slice 10 must confirm that is the intent (open question 7).

---

## 7. Open questions for a human

1. **Unscoped members (§4.3).** Confirm that "isolated" means *scoped members are restricted*
   and NOT *unscoped members get an implied default-lane scope*. If the latter is wanted, it is
   a third setting value (`'strict'`) and a materially larger blast radius — every unscoped
   member of every multi-lane project loses non-default lanes on deploy.
2. **Retrofit.** Should shipping isolation trigger any operator action on existing multi-lane
   projects with scoped members (notification, audit report of who just lost read access), or
   is silent tightening acceptable?
3. **Failure mode.** When `resolveReadLanes` cannot read `project_settings` (DB blip), fail
   **closed** (isolate, possibly hiding a lead's own lane) or **open** (current behaviour)?
   Every existing authority helper in that directory fails toward the restrictive answer for
   writes; for reads, failing closed produces a confusing empty editor. Recommendation: fail
   closed for the lane set but log loudly, and treat it as a 5xx-worthy condition the way
   `role_lookup_failed` is treated at mint time.
4. **Cross-lane aggregates (§4.9).** Acceptable that a scoped member can difference their own
   lane out of a cross-lane sum, or must #21/#22 serve them lane-scoped rollups?
5. **Comments (§4.7).** Do comment threads need lane scoping in v1? They frequently quote the
   translation, but they are not lane-addressable and gating them means a schema change.
6. **Lane names (§4.8).** Under isolation, may a scoped member see that other lanes *exist*?
   Recommendation is yes; some deployments may disagree.
7. **Agent / external tokens (#34–36).** Does an Agent API token inherit its minting user's
   lane set, or does the external channel get its own scope model? An agent reading a lane its
   operator cannot read is a real bypass.
8. **File scopes.** `project_member_scopes` also holds `kind='file'`. Should the read wall gate
   on those too (a reviewer scoped to one book reads only that book), or is v1 lanes-only?
   Recommendation: lanes-only, because file scopes interact with the anchor-chain read in ways
   worth designing separately.
9. **Chain-link disclosure (§4.4).** Confirm it is acceptable that lane isolation does not hold
   across a `consumes: 'target'` link edge, and that this is a copy/documentation problem rather
   than a blocker.
10. **Delta id side-channel (§4.6).** Accept and document, or block the wall on slice 9?
11. **Sequencing.** Is a partial wall shippable? Slices 3+4 close the large-volume paths while
    #6 (`GET /events`) stays wide open until slice 9. Either we ship isolation knowing one
    documented hole remains, or slices 8–9 become blockers and the whole thing lands as one
    large release. Recommendation: ship incrementally, and be explicit in the settings copy
    that history/audit surfaces are not yet lane-filtered.
