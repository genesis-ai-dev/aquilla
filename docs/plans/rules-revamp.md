# Rules Revamp — Plan & Design Spec

Improve the Rules feature across three axes: (1) a Linear-quality UI that lives **inside the editor surface**, (2) bulk rule import by dropping a document (Text/PDF/DOCX) that a fast LLM extracts and a second pass formats, and (3) a real "extract rules from edits" pipeline mining **both** repeated/recent diffs (D1 event log) and validated pairs.

## Current state (grounding)

- Types: `src/lib/parsers/types.ts:71-130` — `TranslationRule` { id, name, description, severity: major|minor, source: algorithmic|llm|user, scope: project|org, check, enabled, createdAt, autofix? }. `RuleCheck` = source-requires-target | target-forbids | source-target-match | builtin.
- Standalone route `RulesPage` at `/project/:id/rules` (`src/components/RulesPage.tsx`) — full-screen page, leaves the editor shell.
- `RuleDrawer` (`src/components/RuleDrawer.tsx`) — right 320px panel in `ProjectWorkspace` via `?openRule=<id>`.
- Manual create: `RuleCreateDialog.tsx`. LLM suggest: `RuleSuggestDialog.tsx` + `src/lib/rules/rule-suggester.ts` (`suggestRulesFromPairs`, max 20 validated pairs).
- Validated pairs: `collectValidatedPairs()` `src/lib/completion/completion-service.ts:34-58`.
- Rule engine: `src/lib/rules/rule-engine.ts`. Built-ins: `src/lib/lqa/builtin-registry.ts` (9 checks). Autofix: `src/lib/rules/autofix.ts`.
- LLM calls: `complete()` in `completion-service.ts` → Frontier chat endpoint; usage tracked via `addLlmCall`.
- Editor shell: `ProjectWorkspace.tsx` (AppShell — fixed WorkspaceHeader, TabStrip, EditorTable main, right drawers, WorkspaceStatusBar bottom).
- Persistence: rules in `ProjectRecord.rules[]` (IndexedDB) synced as JSON blob via `auth-worker/src/routes/project-settings.ts`. No edit-history mining exists today; cell edits live in the D1 sync event log.

## Design principles (Linear-quality)

- The shell (left sidebar, top bar, bottom status bar) stays fixed; **only the main editor content area swaps** to the Rules surface. No leaving to a separate full-page route; no modal stacks for primary flows.
- Rules surface is a panel that renders *in place of / beside* the editor table, reachable from a top-bar/segmented control, keeping the same chrome.
- All the little menus (create, edit, suggest, import) render as inline sections/popovers **within the main area**, not as standalone routes.
- Rule authoring reads like plain language: "On the **[source/target]**, this pattern must be **[present / forbidden]**." Severity and enabled inline. Live preview of matches against current file.
- Keyboard-first, fast, dense, calm. Empty states teach. Progress is shown for async LLM work.

## Workstreams (vertical slices)

### A. In-editor Rules surface (UI shell migration)
- Replace standalone `/rules` route navigation with an in-shell Rules view: keep WorkspaceHeader/sidebar/status bar fixed; main content toggles between Editor and Rules via a segmented control in the top bar.
- Port RulesPage content (built-in checks list + user rules list) into the in-shell surface as inline sections.
- RuleDrawer violations view stays as a contextual right panel but visually aligned to the new surface.
- Keep `/project/:id/rules` URL working (deep-link) but render within the shell, not as a separate page.
- Acceptance: navigating to Rules never unmounts the sidebar/top/bottom bars; only the center swaps.

### B. Intuitive rule authoring (create/edit UX)
- Redesign `RuleCreateDialog` into an inline rule editor on the surface (and reuse for edit).
- Plain-language builder: choose side (source/target), mode (required/forbidden/match), pattern input with regex/literal toggle and validation, severity, enabled.
- Live preview: run the draft rule against the current file's cells, show match count + sample highlighted cells before saving.
- Autofix authoring inline (regex replace) with before/after preview (reuse `autofix.ts`).
- Acceptance: a non-technical user can author a forbidden-term and a required-term rule without reading docs; invalid regex is caught before save.

### C. Document import → LLM rule extraction (multi-pass)
- New "Import from document" entry on the Rules surface. Accept paste, .txt, .md, .pdf, .docx; enforce a max size (e.g. 200KB text / 2MB file).
- PDF/DOCX → text via a worker parsing step (new endpoint in auth-worker or sync-worker); text/md parsed client-side.
- Pass 1 (fast model): extract candidate rules/observations from unstructured text → list of raw candidates with a running "Extracting N rules…" progress UI.
- Pass 2 (formatter model): convert candidates into structured `TranslationRule` drafts (name, description, side, mode, pattern, severity).
- Review screen: user accepts/edits/rejects each draft before commit (reuse RuleSuggestDialog review pattern). Track usage via `addLlmCall`.
- Acceptance: dropping a style-guide doc yields ≥1 well-formed, editable rule draft; oversize input is rejected with a clear message; progress is visible.

### D. Extract rules from edits (diffs + validated pairs)
- Build an edit-mining service: read cell edit events from the D1 sync event log; detect **repeated** edits (same correction applied across multiple cells) first, then **recent** edits.
- Rank candidates: repeated > recent; combine with existing validated-pair suggestions (`suggestRulesFromPairs`) into one ranked list.
- LLM pass turns top patterns into rule drafts; surface in the same review screen as C.
- "Suggest from edits" button on the Rules surface triggers this; show why each rule was suggested (e.g. "corrected in 4 cells").
- Acceptance: a correction repeated across cells appears as a top-ranked suggested rule with its evidence; validated-pair suggestions still appear, ranked below repeats.

## Cross-cutting
- Persistence/sync of new rule shapes via existing `project-settings` blob (no schema change needed unless new fields added — keep `RuleCheck` union, extend minimally).
- All LLM work shows progress + records usage; fast model for extraction, stronger model for formatting.
- Every surface verified in the real UI (verify-dev-change) with the seeded dev user.
