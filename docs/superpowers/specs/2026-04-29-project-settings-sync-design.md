# Project Settings Sync — Design

**Date:** 2026-04-29
**Status:** Draft
**Scope:** Project-wide settings (languages, system prompt, rules, health, validation counts) move out of local-IDB-only storage and into a server-authoritative D1 row served by REST endpoints on frontier-server. Local IDB becomes a write-through cache. Edits gated to PROJECT_LEAD+ (role 500+) and require an online connection. Device-local settings (apiKey, endpoint, audio strategy, experimental flags, TTS, dismissed-banner state) stay in IDB unchanged.

## Problem

A REVIEWER on a translation team gets a new laptop, signs in to the web app, opens a project the maintainer set up weeks earlier. The workspace header shows "Languages not set", the rules drawer is empty, and the AI completion system prompt is blank. She cannot tell whether the project was never set up or her sync hasn't kicked in. She messages the maintainer; the maintainer says "it's been set up for weeks." Twenty minutes lost on a question whose answer is *the project's settings exist on someone else's device*.

The same gap surfaces when:
- A contributor's browser clears IndexedDB under disk pressure
- A user opens the project on a different browser or in private mode
- A new collaborator joins and opens the project before any maintainer touches it on this device

The settings absent from a fresh-device open are the team's *shared norms* — they should be present immediately on any device a member opens the project.

## Goals

- Languages, system prompt, rules, health/validation knobs are present on first open from any device, without manual setup.
- A REVIEWER (300) opening a configured project sees real values, not "not set" placeholders.
- A PROJECT_LEAD+ (500+) editing a setting on Device A sees that edit on Device B after refreshing the project on Device B.
- Sub-PROJECT_LEAD users see disabled fields with a tooltip naming the required role.
- Edits require an online connection; offline shows fields as read-only with a "reconnect to edit" hint. (No queued offline writes — they create conflict surface area without proportional value for fields edited monthly.)
- Local IDB cache survives offline read; existing offline-read UX unchanged.
- Existing IDB-only projects migrate transparently on first open by a CONTRIBUTOR+.

## Non-Goals

- Real-time push from server to other connected clients. These fields are edited monthly; refresh-to-see-edits is acceptable. (Add SSE later if usage data argues for it.)
- API key / endpoint URL / audio strategy / experimental flags / TTS / per-user UI dismissals — all stay device-local. API key in particular is intentionally never synced; org-level centralization is handled separately by frontier-server's existing LLM proxy and is the topic of a future spec.
- Y.Doc-backed sync for these fields. CRDT merge semantics are unnecessary at this edit cadence; D1 + REST is simpler and sufficient.
- Org-level settings inheritance. Each project owns its own settings row. (Org-level defaults could come later; out of scope here.)
- Field-level audit history ("who changed the system prompt"). The D1 row carries `updated_at` and `updated_by` only.

## Current State

### Field locations today (`src/lib/parsers/types.ts:192` `ProjectRecord`)

All of these live in IDB only, on the per-device `ProjectRecord`:

```ts
sourceLanguage: string
targetLanguage: string
completionSettings?: { endpoint, apiKey, systemPrompt, ... }
rules?: TranslationRule[]
rulePenalties?: RulePenalties
healthSettings?: HealthSettings
validationCount?: number
validationCountAudio?: number
audioMediaStrategy?: AudioMediaStrategy
ttsSettings?: ProjectTtsSettings
experimentalFlags?: Record<string, boolean>
setupChecklistDismissed?: boolean
suggestionsDismissedAt?: string
```

Reads happen in `useProject` (project-index IDB), consumed by `WorkspaceHeader`, `ProjectCard`, `ProjectSettings`, the rule engine, the completion service, and the health engine. Writes happen via `patchProject` from `ProjectSettings`, `RuleCreateDialog`, the rule autofix path, and the setup checklist.

### Server today (frontier-server D1, `frontier-db-v2`)

- `projects(id, name, gitlab_project_id, org_id, created_by, archived_at, archived_by, ...)` — no settings columns.
- `GET /api/v2/projects/:id` returns `{id, name, gitlabProjectId, archivedAt, archivedBy, role}`. No project-wide settings.
- `GET /api/v2/projects` (list) returns the same shape per row plus a files summary.

The frontier-server already proxies LLM completion requests, so the org-level "BYO key vs. use frontier proxy" decision is implementable when needed; this spec doesn't extend the proxy.

### Field split (this spec)

**Project-wide → moves to D1 + REST:**
- `sourceLanguage`
- `targetLanguage`
- `completionSettings.systemPrompt` (only this sub-field; not `endpoint` or `apiKey`)
- `rules`, `rulePenalties`
- `healthSettings`
- `validationCount`, `validationCountAudio`

**Device-local → stays in IDB unchanged:**
- `completionSettings.endpoint`
- `completionSettings.apiKey`
- `audioMediaStrategy`
- `experimentalFlags`
- `ttsSettings`
- `setupChecklistDismissed`
- `suggestionsDismissedAt`

The `completionSettings` object is therefore split: `systemPrompt` syncs, `endpoint` and `apiKey` do not. UI hint on the API key field reads "Stays on this device — not shared with collaborators."

## Data Model

### frontier-server D1 — migration 0017

```sql
-- Project-wide settings, one row per project (1:1 with projects.id).
-- All synced fields stored as a single JSON blob to keep schema migrations
-- cheap as new project-wide knobs land. updated_at + updated_by feed the
-- conflict-detection ETag.
CREATE TABLE project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  -- JSON object with these keys (any may be absent / null):
  --   sourceLanguage: string
  --   targetLanguage: string
  --   systemPrompt: string                       (completionSettings.systemPrompt)
  --   rules: TranslationRule[]
  --   rulePenalties: RulePenalties
  --   healthSettings: HealthSettings
  --   validationCount: number
  --   validationCountAudio: number
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  -- Monotonic counter — incremented atomically on every PATCH. Clients
  -- send ETag = previous value; server rejects stale writes with 409.
  version INTEGER NOT NULL DEFAULT 0
);
```

JSON-blob choice rationale: the synced shape is read whole (used by the workspace, the rules engine, the completion service); querying individual sub-fields server-side is not a use case. Schema migrations for new settings keys become "client adds field, old clients ignore unknown keys" — no SQL migration per addition. The trade-off is loss of column-level constraints; acceptable here because validation is enforced client-side and re-checked server-side per-field.

`updated_by` and `updated_at` exist only to power the conflict toast ("Synced an update from <username>"). No history table.

### REST shape

```
GET    /api/v2/projects/:id/settings
PATCH  /api/v2/projects/:id/settings    (PROJECT_LEAD+ only; If-Match: <version>)
```

**`GET` response:**
```json
{
  "version": 7,
  "updatedAt": "2026-04-29T14:30:00Z",
  "updatedBy": { "id": 42, "username": "ryder" },
  "settings": {
    "sourceLanguage": "en",
    "targetLanguage": "swh",
    "systemPrompt": "Translate idiomatically...",
    "rules": [...],
    "rulePenalties": {...},
    "healthSettings": {...},
    "validationCount": 2,
    "validationCountAudio": 1
  }
}
```

When no row exists yet (project just created, never had settings), server returns the row with `version: 0` and `settings: {}`. Never 404 — a project that exists *has* a settings row, possibly empty.

**`PATCH` request:**
```json
{
  "settings": { "systemPrompt": "Translate formally..." },
  "ifMatchVersion": 7
}
```

Server merges (top-level keys; replacing nested objects whole — no deep merge), bumps `version`, sets `updated_at` and `updated_by`. On `ifMatchVersion` mismatch returns `409 { latest: <current GET response> }`. On role check failure returns `403 { required: 500, role: <caller's role level> }`.

Auth: same Bearer JWT as other v2 endpoints. Role resolution via existing `resolveProjectRole`. Write requires `role.level >= 500`.

`PATCH` of an empty settings row by a CONTRIBUTOR (400) is intentionally still 403. Migration of legacy IDB-only data is performed by PROJECT_LEAD+ only (see Migration section); a CONTRIBUTOR opening a not-yet-migrated project will see whatever local IDB has plus an empty server response, until a maintainer-level user opens it on a device with the values.

## Client Integration

### `useProjectSettings(projectId)` — new hook

```ts
interface ProjectSettingsState {
  settings: ProjectWideSettings           // merged local + server
  version: number | null                  // null = never fetched
  isLoading: boolean
  isOnline: boolean                       // navigator.onLine + listener
  canEdit: boolean                        // role.level >= 500 && isOnline
  reasonCannotEdit: "offline" | "role" | null
  patch: (partial: Partial<ProjectWideSettings>) => Promise<PatchResult>
  refresh: () => Promise<void>
}
```

- On mount: read from IDB cache, surface immediately. Then fetch `GET /settings`. Merge: server wins for keys it has set; local fills gaps. Persist merged result back to IDB.
- `patch` is the only writer. Sub-PROJECT_LEAD or offline → returns `{kind: "blocked", reason}` without firing the request. Online + role OK → optimistic update to local state + IDB, fires `PATCH` with current `version`. On 200 update version. On 409 → snap to server's `latest` and surface a toast naming `updatedBy`. On 403 → log a warning (UI shouldn't have shown the editor); do not retry.
- Listens for `online`/`offline` events and refreshes when transitioning offline → online so a returning user sees the latest server state.

### `useProject` — narrow merge change

Already merges server cloud-project metadata over local IDB after the previous fix. Extend the merge to consume `useProjectSettings`'s settings object on top of the IDB-cached `ProjectRecord`. The displayed `ProjectRecord` becomes:

```
{...idbRecord, ...projectWideSettingsFromServer}
```

(With the device-local fields like `endpoint` and `apiKey` always coming from `idbRecord`, never from server.)

This keeps `ProjectRecord` as the single shape consumed by the rest of the app — no rippling type changes through `WorkspaceHeader`, `ProjectSettings`, `EditorTable`, etc.

### `ProjectSettings.tsx` — UI changes

- Each project-wide field rendered with a `disabled` state when `!canEdit`. Tooltip text:
  - Offline: "Reconnect to edit shared settings."
  - Sub-role: "Project Lead or higher can edit shared settings." (Show `PROJECT_LEAD` description verbatim.)
- Device-local fields (endpoint, apiKey, audio strategy, etc.) keep current behavior — editable offline, no role gate.
- API key field gains a hint: "Stays on this device — not shared with collaborators."
- A small "Last edited <relative time> by <username>" line under each section that has shared fields, sourced from `updatedBy`/`updatedAt`.
- On 409 conflict toast appears bottom-right: "Synced settings update from <username>." Form fields snap to new server values.

### `ProjectCard.tsx` and `WorkspaceHeader.tsx`

No structural change beyond the previous PR (which already gracefully renders blank language fields). They consume `ProjectRecord` through the existing path; the merge in `useProject` does the work.

### Empty-state copy

When languages are absent for a project that *does* have a server settings row (i.e., genuinely unset, not a sync gap):
- ProjectCard shows "Awaiting setup by <maintainerUsername>" instead of "Languages not set". Maintainer username comes from the project's owner/creator (already available).
- WorkspaceHeader hides the language segment entirely (current behavior).

When the server has not been reached yet on this open and IDB has nothing:
- ProjectCard shows a small skeleton on the language line for up to 1.5s, then the "Awaiting setup" copy if still empty.

## Migration

Existing projects have settings only in IDB on whichever device they were configured on. Migration is opportunistic and one-shot per project:

1. Any user opens project P. `useProjectSettings` fetches `GET /settings`.
2. If server returns `version: 0` and `settings: {}` AND local IDB has a non-empty `ProjectRecord` for P:
   - If user is PROJECT_LEAD+ on P: client fires a single `PATCH` with all project-wide fields from local IDB, `ifMatchVersion: 0`. On success, normal flow continues. On 409 (someone else migrated concurrently) — re-fetch and merge.
   - If user is below 500: nothing happens; client uses local IDB values for display. Migration waits for the first maintainer-level open.
3. After migration, the project is permanently on server-authoritative settings.

Edge: two PROJECT_LEAD+ devices both have non-empty IDB and both open simultaneously. Both POST `ifMatchVersion: 0`. One wins (server returns 200, version: 1). The other gets 409 and merges — its local fields that the winner didn't include are added in a follow-up PATCH (now `ifMatchVersion: 1`). End state: union of both devices' values.

Edge: device A has `sourceLanguage: "en"`, device B has `sourceLanguage: "english"`. Migration is "first wins for keys present in both." Acceptable; the team can edit afterward. Logged client-side ("Migrated <N> settings; <M> conflicts kept device B's values") for diagnostics, not user-facing.

No server-side data migration required — `project_settings` rows are created on demand by the first PATCH or read as `{version: 0, settings: {}}` if absent.

## Online-Only Edit

`canEdit = role.level >= 500 && navigator.onLine`. The `online`/`offline` events drive a re-render. While typing into a now-disabled field is annoying mid-edit, the alternative (queue local writes for replay on reconnect) creates conflict scenarios that are harder to reason about for fields edited monthly. We accept the rough edge.

Field UX while offline:
- Field is `disabled` with the offline tooltip.
- Existing typed-but-unsaved value is preserved in component state (not blown away).
- On reconnect, field re-enables with the pending value; user re-blurs to commit.
- If user navigates away while offline with unsaved values, those values are lost. We do not warn — that surface area is its own design problem and not worth the complexity here.

## Observability

- Server logs PATCH `version` transitions with project_id and user_id. Lets us audit "who set the system prompt" without an audit table.
- Client logs migration events to PostHog: `project settings migrated` with `{projectId, fieldsCount, conflictsCount}`. Drives the success metric.
- Error path: 409 conflicts logged to PostHog as `project settings sync conflict` to validate that the rate stays low. Threshold: < 1% of PATCH requests.

## Failure Modes

| Mode | Status | Mitigation |
|---|---|---|
| Two maintainers edit a setting within seconds; one edit lost without warning | Catchable | `ifMatchVersion` ETag → 409 → snap-to-server toast naming the other user. Metric: 409 rate < 1%. |
| Migration race: two devices both PATCH from version 0 | Preventable | Server's atomic version increment guarantees one wins; loser merges via 409 path. |
| Stale JWT after role downgrade | Preventable | Server re-validates role at request time, not from JWT claim. |
| Sub-MAINTAINER user sees disabled field with no explanation | Preventable | Disabled-with-tooltip naming the required role and current user role. |
| Schema drift: new client adds `newField`, old client doesn't know it | Preventable | Server merge is top-level keys; old clients omit unknown keys on PATCH; new keys survive. |
| User clears IDB while offline and reopens project before reconnecting | Preventable | Read shows local empty state; languages blank. On reconnect, GET fills everything in. Same UX as a fresh device opening the project. |
| Migration overwrites a non-empty server row with stale local data | Preventable | Migration only fires when server returns `version: 0`. Once any device has migrated, server is authoritative forever. |
| Per-device API key gets confused with project settings ("why isn't my key on Device B?") | Catchable | Settings page hint on the API key field. Metric: zero support tickets about "missing API key on new device". |

## Success Metric

On project opens by signed-in users where the server's settings row has any populated field, the WorkspaceHeader renders real `source → target` languages within 2s of mount in **≥ 95% of opens**, measured over 7 days post-launch. PostHog event: `project settings hydrated` with `{projectId, withinMs}`; success ratio computed from this stream.

Secondary metric: 409 conflict rate on `PATCH /settings` stays below 1% of PATCH requests. If it exceeds 1% sustained, revisit either the conflict UX or move toward push-based notifications.

## Out of Scope (Future Specs)

- **Server-managed API key + completion proxy.** API key remains device-local in this spec. If org-level centralization is desired, configure frontier-server's existing LLM proxy at the org level so users select "use org model" and don't enter a key locally. That work has its own UX and security surface and gets its own brainstorming pass.
- **Real-time push of settings updates.** Refresh-to-see-edits is good enough at the current cadence. If usage data shows users hitting stale settings, layer SSE on the GET endpoint.
- **Audit log of who changed what.** `updated_by` + `updated_at` cover the most-asked question; full history is a separate feature.
- **Org-level settings inheritance** (org-default system prompt, etc.). Defer until org governance asks for it.
- **Bulk settings copy** ("apply this project's settings to N other projects"). Not a today problem.

## Implementation Phases

Phase 1 — server (frontier-server):
- Migration 0017 creates `project_settings` table.
- New endpoints `GET` and `PATCH /api/v2/projects/:id/settings` with role gating and version-based ETag.
- Tests: role gate at 500/400 boundary, 409 on stale version, merge behavior, role re-check after JWT-claimed downgrade.

Phase 2 — client (codex-web-app):
- New `useProjectSettings(projectId)` hook with online detection and merge logic.
- `useProject` extended to merge server settings over IDB cache for the shared subset.
- `ProjectSettings.tsx` field disable/tooltip per role and connectivity, "last edited by" line, conflict toast.
- API key field hint text.
- ProjectCard / WorkspaceHeader empty-state copy refinement.
- Migration path on first open by PROJECT_LEAD+.

Phase 3 — instrumentation:
- PostHog events for migration, conflicts, hydration latency.
- 7-day metrics review against the success metric before declaring done.

## Open Questions

None blocking. Two items the author flagged in the loop and answered:

- **Substrate (D1+REST vs Y.Doc):** D1+REST chosen. Edit cadence on these fields is monthly, conflict rate is near-zero; CRDT properties are theatre. Architectural-uniformity argument for Y.Doc was acknowledged and weighed; ruled out for these specific fields.
- **Edit role gate:** PROJECT_LEAD (500). Aligns with "manage members" already at this rung.
- **API key sync:** device-local always. Org centralization belongs to the existing frontier-server LLM proxy, configured at the org level — not synced through this spec.
