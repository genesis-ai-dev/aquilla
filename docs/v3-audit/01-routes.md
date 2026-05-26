# v3 Audit — Routes & Navigation

## Summary
The app nominally targets v3 (event-log only, D1 projections) but the route/navigation layer contains five significant findings: two broken hardcoded paths, two semantic inconsistencies in dashboard routing, legacy redirect patterns, and unused navigation builder functions. The working-tree changes to `navigation.ts` fix v1 cruft (`/w/`, `/projects/` paths) but don't address the runtime path assignments in `ProjectWorkspace`.

## Findings

### F1: Stale route path in ProjectWorkspace exit flow
- **Severity**: high
- **Category**: legacy-v2 | bug
- **Evidence**: src/components/ProjectWorkspace.tsx:115
- **What's wrong**: `goToProjects()` uses `window.location.assign("/projects/")` when the user loses access or sees a 404. This is a v2 path that no longer routes coherently: `/projects` maps to Dashboard at line 78 of src/App.tsx, but the trailing slash creates a mismatch. More critically, this hardcoded string bypasses the navigation builders and will break if the path convention changes.
- **Suggested fix**: Replace with `navigate("/")` or create a `buildDashboardUrl()` in navigation.ts and use it consistently. The root `/` is the canonical dashboard entry point; `/projects` exists only to catch the dev-mode workspace catch-all.

### F2: Navigation builder functions unused or pointing wrong
- **Severity**: high
- **Category**: dead-code | mismatch
- **Evidence**: src/lib/ad11/navigation.ts:23–40 (buildImportHandoffUrl, buildExportHandoffUrl)
- **What's wrong**: These builders generate URLs to `/import/` and `/export/` (lines 23, 35), but no such routes are defined in src/App.tsx. They are only called from ProjectWorkspace (used once in lines that build handoff URLs) but the actual routes don't exist in the app. This suggests the import/export flow was removed but the builders were left behind.
- **Suggested fix**: Either restore the routes (if they were accidentally removed) or delete the builder functions and call sites. Verify with git history whether this was intentional.

### F3: Dashboard reached via both "/" and "/projects" with inconsistent semantics
- **Severity**: medium
- **Category**: mismatch | legacy-compat
- **Evidence**: src/App.tsx:61 and 78; src/components/Dashboard.tsx navigation
- **What's wrong**: Both `/` (canonical) and `/projects` map to Dashboard. The comment on line 75–77 explains this is a dev-mode workaround ("without an explicit /projects route the `/:id` workspace catch-all eats it"), but at runtime, `goToProjects()` hardcodes `/projects/` while the app's internal link builders reference `/`. This breaks the semantic invariant that there is one canonical URL per logical page.
- **Suggested fix**: Keep only `/` as canonical. Remove the `/projects` route once the dev-mode catch-all issue is resolved (e.g. via a front-door Worker that doesn't leak `/project/:id` into the SPA).

### F4: Navigation builders in navigation.ts don't match App.tsx routes
- **Severity**: medium
- **Category**: mismatch
- **Evidence**: src/lib/ad11/navigation.ts:47 (buildProjectSettingsHandoffUrl creates `/project/:id/settings`); working-tree diff shows this was changed from `/projects/:id/settings`
- **What's wrong**: The navigation builder is being patched in the working tree to match the v3 route structure, but no corresponding route changes have been made to App.tsx. This indicates the builders were out of sync with the route definition and the fix is incomplete.
- **Suggested fix**: Commit the navigation.ts changes separately and verify that all callers of buildProjectSettingsHandoffUrl and workspaceReturnPath are tested to ensure they land on the correct routes.

### F5: Backward-compat redirect /settings/org→/members is unclear in intent
- **Severity**: low
- **Category**: legacy-compat | doc-mismatch
- **Evidence**: src/App.tsx:85
- **What's wrong**: The redirect from `/settings/org` to `/members` suggests a v1/v2 admin path structure. The comment says "old admin-flavored URL" but doesn't clarify when this was deprecated or whether the old code that links to it still exists. Orphaned redirects accumulate technical debt.
- **Suggested fix**: Search the codebase for any remaining links to `/settings/org`. If none exist, remove the redirect. If they do, file a separate cleanup task to migrate callers to `/members`.

### F6: Missing v3 route: /project/:id/settings may have been accidentally restored
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: src/App.tsx:66 (route exists); user's stated concern "was apparently missing after refactors"
- **What's wrong**: The route `/project/:id/settings` is defined and maps to ProjectSettings, but the user flagged it as missing in v3 refactors. This suggests either (a) it was missing and has been restored but not tested, or (b) the user's understanding was stale. Either way, there's no evidence that the route is wired to the correct component or that the component works correctly.
- **Suggested fix**: Verify that ProjectSettings component loads and functions correctly when accessed via `/project/:id/settings`. Add integration test if missing.

## Open questions
- Why do buildImportHandoffUrl and buildExportHandoffUrl exist if the routes `/import/` and `/export/` are not in the app? Were these removed intentionally in v3?
- Are there any callers of `/settings/org` still in the codebase, or can the legacy redirect be removed?
- What was the original reason for the `/projects` route? Once the front-door Worker is in place, should it be removed?
- The working-tree changes to navigation.ts fix the route paths, but why weren't they committed already? Are they blocking on test coverage?

## Files reviewed
- src/App.tsx (route definitions)
- src/lib/ad11/navigation.ts (navigation builders, including working-tree changes)
- src/components/ProjectWorkspace.tsx (goToProjects hardcoded path)
- src/components/Dashboard.tsx (navigation to /onboarding, /members, /settings)
- src/components/ProjectSettings.tsx (navigation back to /project/:id)
- src/components/RulesPage.tsx (navigation back to /project/:id)
- git diff output (showing pending route path fixes)
