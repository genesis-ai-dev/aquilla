# AQU-730 read/write wall — PR3 implementation plan (fast-follow)

PR3 wires the AQU-730 wall that already ships **dormant** in PR1 (grant table
`0091`, `laneGrants` token mint, `resolveVisibleLanes` authority + `LaneScopedRead`
brand + ESLint guard). It is a deliberate fast-follow — **not** part of the
lane-ID deploy — because every enforcement flip is sequencing-critical and the
design (`2026-09-10-lane-permissions-and-read-wall-design.md`) rates the full
wall at week+.

Branch: `Luke-Lane-Updates-3` (off PR2 `Luke-Lane-Updates-2`).

## Current state (verified in code)

- `project_member_lane_roles` exists (`0091`), **empty** — no backfill yet.
- `signSyncTokenWithRole` already mints `laneGrants: [{lane, level}]`, omitted
  when empty (`sync-token-mint.ts`). No further token work needed.
- `resolveVisibleLanes(claims, registry)` + `isLaneVisible(visible, tag, side)`
  exist and are unit-tested, but **no route calls them** (header says UNWIRED).
- Write wall `enforceScopes` (`sync-worker/src/events/authorize.ts`) still reads
  the old `scopes` claim, not `laneGrants`.
- `cells-read-route.ts` has **no** reference to the visible set.

## The hard sequencing rule

Enforcement (hiding/denying) is only safe **after** grants exist in prod:

1. wiring that HIDES content (read wall) turns an empty grant set into "below-600
   sees no target lanes" — i.e. hides everything from every translator;
2. the write-wall allow→deny flip locks out every current translator.

Therefore: **grant backfill lands and runs in prod first**, then enforcement is
enabled (ideally behind a kill-switch for the first bake).

## Ordered build

### Slice A — grant backfill (foundation, HIGH risk) [Opus]

Implements design §5 steps 2–5. **Open decision — how to compute `R_p`:**

- **(A1, recommended) Run inside the worker**, reusing `resolveProjectRole`
  verbatim: a one-off auth-worker admin route / script entry that iterates
  projects+members and writes grants. Faithful to the live max-wins logic (the
  design's flagged #1 risk is a wrong `R_p`), at the cost of not being a plain
  `tsx` script.
- (A2) Standalone `tsx` backfill (like `neon-backfill-lanes.ts`) that
  **reimplements** the max-wins in SQL. Operationally simplest, but duplicates
  the riskiest logic — rejected unless A1 proves impractical.
- (A3) Extract `resolveProjectRole`'s core into a shared pure function used by
  both worker and script. Cleanest long-term; largest diff.

Steps regardless of approach (idempotent, keyed on `(project,user,lane)`):
1. Convert `project_member_scopes kind='lane'` → grant at the member's project
   role level.
2. Preserve-access (POLICY, design OQ#1 — **confirm with Luke/Matthew**): every
   below-600 member with **no** lane scopes → grant on **every current lane** at
   their `R_p`. New lanes post-migration get no auto-grant.
3. 600+ members: no grants (cascade).
4. Dry-run assertion: for sampled projects, new-model `effectiveRoleInLane` ==
   today's effective capability for every (member, lane). Zero regressions.
Dry-run by default; `--apply` writes. Add a `verify`/assertion mode.

### Slice B — `effectiveRoleInLane` + read wall (HIGH risk) [Opus]

- Pure `effectiveRoleInLane(R_p, grantLevel) = max` helper + tests.
- Wire `resolveVisibleLanes` into `cells-read-route` (design slice 7): filter the
  cell query by the visible set for target rows (source always visible), and
  **fold the visible set into the ETag + chainCache key** so two callers with
  different visible sets never collide on a 304. Then validators + progress
  reads (slice 8). Guard each with the `LaneScopedRead` brand.
- Gate behind a per-env kill-switch (env flag) so wiring can ship dark and be
  enabled only after the grant backfill has run in that env.

### Slice C — metadata wall at the settings route (medium) [Grok 4.6 xHigh]

Filter `targetLanes`/`archivedLanes` (and counts) to the visible set at the
project-settings read (design slice 5, closes most of §2). Well-specified,
isolated — good Grok task with a tight spec + my review.

### Slice D — write-wall flip (HIGHEST risk, LAST) [Opus]

Rewrite `enforceScopes` to read `laneGrants` + `effectiveRoleInLane` (design
§4.3). Flip default allow→deny **only** behind the kill-switch, enabled per env
only after Slice A has populated grants there. Repoint the AQU-528 invite-accept
carve-out to write a grant.

### Out of PR3 (later)

DO/realtime visible-lane filtering (slice 9), client cache `grantsVersion`
(slice 10), auth-worker wall (slice 11), members UI per-lane picker (slice 12),
lane-less tables + event-log (slice 13), drop `kind='lane'` scopes (slice 14).

## Testing (local, PGlite + real-PG)

- Grant backfill: unit + the step-4 dry-run assertion on seeded projects
  spanning direct/group/org/creator role sources; idempotency.
- Read wall: seed grants into the token; assert a below-600 member sees only
  granted target lanes + all source; assert ETag differs across visible sets
  (no 304 cross-leak); 600+/platform see all.
- Write wall: below-600 with/without grant; `effectiveRoleInLane` elevation.
- Characterisation baseline (design slice 0) pinned first so regressions show.

## Agent split

- **Opus 4.8 High:** Slices A, B, D (backfill correctness, read-wall ETag
  composition, allow→deny flip) — the lock-out/leak surfaces.
- **Grok 4.6 xHigh:** Slice C (metadata settings filter) + test expansion, from a
  tight spec, reviewed by Opus.

## Immediate next decisions for Luke/Matthew

1. Confirm preserve-access policy (design OQ#1): below-600, unscoped members get
   grants to **all current** lanes at migration. (Blocks Slice A step 2.)
2. Pick grant-backfill approach A1 vs A3.
3. Confirm metadata floor 500 vs 600 (design OQ#3) — affects Slice C.
