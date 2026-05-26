# v3 Audit — Settings & Rules

## Summary
Settings chains of custody are correctly segregated: user-level settings live in localStorage (device-local), project-wide settings route through D1 via `/api/v2/projects/:id/settings`, and rules are stored in IDB and synced through the D1 project row. The `/settings` route exists and is functional (analytics consent + provider override). Two component directories with similar names (`ProjectSettings/`, `project-settings/`) exist but serve distinct purposes and are not duplicates.

## Chains of custody

### User settings
- **Storage**: `localStorage` (device-local, never synced)
- **Scope**: Global across all projects
- **Components**: `src/pages/Settings.tsx` → `PersonalProviderSection`
- **Read/write**: `src/lib/store/user-provider-override.ts` (localStorage), `src/lib/store/user-api-keys.ts` (localStorage)
- **Route**: `/settings`
- **Data**: analytics consent (hook: `useAnalyticsConsent`), AI provider override (endpoint/model/apiKey)

### Project settings
- **Storage**: D1 table `project_settings` (server authoritative, version-tracked)
- **Scope**: Per-project, synced across all members
- **Sync path**: `src/lib/sync/project-settings.ts` → frontier-server `/api/v2/projects/:id/settings` (GET/PATCH)
- **Local mirror**: IDB `projects` store field (ProjectRecord)
- **Fields synced to D1**:
  - `sourceLanguage`, `targetLanguage` (languages)
  - `systemPrompt` (completion settings)
  - `rules`, `rulePenalties` (validation rules)
  - `validationCount`, `validationCountAudio` (validation gates)
- **Fields NOT synced** (device-local only):
  - `completionSettings.endpoint`, `.apiKey`, `.model`, `.maxTokens`, `.temperature` (provider config)
  - `ttsSettings` (voice provider/keys)
  - `decaySettings`, `syncSettings`, feature flags (all device-local)
- **Hook**: `useProjectSettings(projectId, roleLevel)` reads from server first, overlays local IDB
- **Route**: `/project/:id/settings` → `ProjectSettings` component
- **Concurrency**: Server row versioning (409 conflict on stale writes)

### Org settings
- Not found in codebase. Legacy redirect at `/settings/org` → `/members` (MembersPage, not a settings page).

### Rules
- **Primary storage**: IDB `projects.rules` array (part of ProjectRecord)
- **Secondary storage**: D1 `project_settings.settings.rules` (JSON blob)
- **Write path**: `useRules.ts` (addRule/updateRule/deleteRule) → `patchProject(projectId, {...p, rules: [...]})` → local IDB
- **Server sync**: Rules are synced to D1 as part of `ProjectWideSettings` (via `useProjectSettings.patch()`)
- **User rules** vs **built-in rules**:
  - User rules: stored in `project.rules` array, editable
  - Built-in rules: computed from `project.algorithmicChecks` overrides, not stored as full rules
- **Hook**: `useRules(project, refresh)` reads `project.rules`, provides CRUD + penalty management
- **Rule penalties**: `rulePenalties` stored in both IDB and D1
- **Components**: `RulesPage.tsx`, `RuleDrawer.tsx`, `RuleSuggestDialog.tsx`
- **Rule engine**: `src/lib/rules/rule-engine.ts` (memoized regex cache, executes at generation time, not in prompt)

## Findings

### F1: Two ProjectSettings directories with overlapping names
- **Severity**: medium
- **Category**: dead-code | mismatch
- **Evidence**:
  - `/src/components/ProjectSettings/` contains sections: `AudioMediaStrategySection.tsx`, `DecaySettingsSection.tsx`, `ValidationSettingsSection.tsx`, `VoiceLibrarySection.tsx`, `DisabledFieldTooltip.tsx`
  - `/src/components/project-settings/` contains utilities: `dirty.ts`, `dirty.test.ts`
  - `/src/components/ProjectSettings.tsx` imports from `ProjectSettings/` subdirectory (components)
- **What's wrong**: Directory naming convention is unclear. `ProjectSettings/` uses PascalCase (component pattern) but contains sub-components. `project-settings/` uses kebab-case but contains utilities. The distinction is functional but the naming risks future confusion.
- **Suggested fix**: Rename `/src/components/project-settings/` → `/src/components/ProjectSettings/utils/` to signal that utilities belong under the main ProjectSettings component tree.

### F2: User-level /settings page is minimal and incomplete
- **Severity**: low
- **Category**: feature-incomplete
- **Evidence**: `src/pages/Settings.tsx` lines 1-62 render only:
  - Analytics consent toggle (via `useAnalyticsConsent` hook)
  - PersonalProviderSection (device-local AI provider override)
  - No import/export settings, no data deletion, no account/sync preferences
- **What's wrong**: The page describes "Preferences that apply to you across all projects on this device" but only covers two settings. If more user-level preferences exist elsewhere (account settings, sync options, etc.), they're not integrated here.
- **Suggested fix**: Audit what user-level settings exist in the broader app and decide whether `/settings` should surface them, or accept that the page is intentionally minimal.

### F3: ProjectSettings component does not expose validation count as editable field
- **Severity**: low
- **Category**: feature-mismatch
- **Evidence**: `src/components/ProjectSettings.tsx` reads `validationCount` and `validationCountAudio` from IDB (lines 107-108, 135-136) but the form does not show UI to edit them. These fields sync to D1 via `useProjectSettings.patch()` but are not exposed in the form.
- **What's wrong**: The fields are wired to sync but have no UI. They may be edited elsewhere (RulesPage?) or remain read-only. The setup is incomplete.
- **Suggested fix**: Add input fields to the ProjectSettings form to edit validation counts, or document where they are managed and remove them from ProjectSettings.

### F4: Completion settings split between local IDB and shared D1 settings
- **Severity**: low
- **Category**: mismatch
- **Evidence**: `src/lib/sync/project-settings.ts` line 20 defines ProjectWideSettings without endpoint/apiKey/model/temperature (device-local); but `src/hooks/useCompletionSettings.ts` (line 43-45) reads from IDB and merges with `systemPrompt` coming from server.
- **What's wrong**: The architecture is correct but the split is not visually clear in ProjectSettings.tsx. Developers might assume all completionSettings sync when only systemPrompt does.
- **Suggested fix**: Add a comment in ProjectSettings.tsx (around line 166) explaining which completion fields sync vs stay local.

### F5: Rules stored in IDB and D1, but D1 patch path not gated by version in useRules.ts
- **Severity**: low
- **Category**: bug
- **Evidence**:
  - `useRules.ts` (lines 30-56) calls `patchProject(project.id, {...})` directly, which updates local IDB only.
  - Rules are synced to D1 via a separate `useProjectSettings.patch()` call in ProjectSettings.tsx, but RulesPage.tsx never calls `patchShared()` for rule changes.
  - This means rule edits on RulesPage do not immediately sync to D1; they only land when the user navigates to ProjectSettings and triggers a save.
- **What's wrong**: Rules can be edited without syncing to the server, creating a gap where changes are local-only until a separate sync event fires.
- **Suggested fix**: Have `useRules` call `patchProject(..., {rules: [...]})` immediately (already does), but also have RulesPage call a server-side patch after each rule operation if online and permitted. Or accept local-only rule edits and sync on ProjectSettings blur.

### F6: Rules not included in ProjectSettings patch path from ProjectSettings.tsx
- **Severity**: medium
- **Category**: bug
- **Evidence**:
  - `src/components/ProjectSettings.tsx` does not import or use `useRules`.
  - Rules form is on a separate page (RulesPage.tsx).
  - ProjectSettings only saves: name, languages, systemPrompt, completionSettings (partial), TTS, decay, validation counts.
  - Rules are synced via ProjectWideSettings but ProjectSettings.tsx never calls `patchShared({rules: ...})`.
- **What's wrong**: The split between ProjectSettings page and RulesPage is architectural, but it means rules are synced to D1 via a different code path (or not at all if RulesPage is never visited).
- **Suggested fix**: Document the intent: are rules synced on-demand when RulesPage saves, or left as local-only until ProjectSettings is opened? If rules must sync immediately, add a server-side rule sync in RulesPage.

### F7: Legacy ydocState field still present in ProjectRecord
- **Severity**: low
- **Category**: legacy-v2
- **Evidence**: `src/lib/parsers/types.ts` line 361 defines `ydocState: string  // base64 encoded Y.encodeStateAsUpdate output`
- **What's wrong**: v3 is event-log based (D1), not CQRS+Yjs. The ydocState field is vestigial from v2 and should be removed unless it's used for backward compat on read.
- **Suggested fix**: Search for ydocState usage across the codebase. If unused, delete the field. If used only for legacy migrations, document that and consider deprecating.

### F8: ProjectSettings component missing save-on-blur for shared fields
- **Severity**: medium
- **Category**: feature-incomplete
- **Evidence**: `src/components/ProjectSettings.tsx` line 152-163 defines `savePartialShared()` but it's never called from form field `onBlur` handlers. Fields are updated locally but not synced to server on blur.
- **What's wrong**: Users edit shared settings (languages, systemPrompt) but don't know when they've been saved to the server. The "Saved" flash appears but only after an explicit action, not on field blur.
- **Suggested fix**: Add `onBlur` handlers to language/systemPrompt inputs that call `savePartialShared()`, similar to how `name` field calls `saveField()` on blur.

### F9: Frontier server project-settings route stateful, IDB also stateful — no conflict detection
- **Severity**: medium
- **Category**: mismatch
- **Evidence**: `frontier-server/src/routes/project-settings.ts` line 1-184 (from shards) has version checking on PATCH but useProjectSettings optimistic update (line 266) applies before server response. On 409, `useProjectSettings` snaps local IDB to latest (line 280), but ProjectSettings.tsx form state is not reverted.
- **What's wrong**: The form is not a controlled component. When a 409 conflict occurs, the server truth is stored in IDB but the in-flight form fields still show the stale user edits. Next blur will overwrite the conflict winner.
- **Suggested fix**: Add a conflict listener in ProjectSettings that reverts form fields when `conflictBy` is set (already exists line 66-71) but ensure all inputs reset to loaded state.

### F10: No audit trail for project settings changes
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: ProjectSettingsResponse (line 27-32 in project-settings.ts) includes `updatedAt` and `updatedBy`, but ProjectSettings.tsx doesn't display them. The server tracks who made the last change, but the UI doesn't show it.
- **What's wrong**: Collaborative projects benefit from visibility into who changed what and when. The server is tracking it but the client doesn't surface it.
- **Suggested fix**: Display "Last edited by {username} at {time}" in ProjectSettings header; show on conflict dialog.

## Open questions
- Are rules intended to sync to D1 immediately on RulesPage save, or only when ProjectSettings is opened?
- Should the ydocState field be removed, or is it used for v2→v3 migrations?
- Is the validation count editable on purpose (wired but no UI), or should it be removed from useProjectSettings?
- Should ProjectSettings form fields save on blur, or is the current manual-save pattern intentional?

## Files reviewed
- src/pages/Settings.tsx
- src/components/ProjectSettings.tsx
- src/components/RulesPage.tsx
- src/components/RuleDrawer.tsx
- src/components/settings/PersonalProviderSection.tsx
- src/components/ProjectSettings/*.tsx (subdirectories)
- src/components/project-settings/dirty.ts
- src/hooks/useProjectSettings.ts
- src/hooks/useRules.ts
- src/hooks/useCompletionSettings.ts
- src/lib/sync/project-settings.ts
- src/lib/store/project-index.ts
- src/lib/store/user-provider-override.ts
- src/lib/store/user-api-keys.ts
- src/lib/rules/rule-engine.ts
- src/lib/parsers/types.ts
- src/App.tsx
- frontier-server/.../routes/project-settings.ts (via shards)
