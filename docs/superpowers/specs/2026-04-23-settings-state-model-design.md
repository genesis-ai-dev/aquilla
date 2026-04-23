# Settings State Model — Design

**Date:** 2026-04-23
**Scope:** Project-scoped settings, with first application to the LLM/AI configuration flow.
**Status:** Spec — implementation plan to follow.

## Problem

Two concrete bugs surfaced the underlying issue:

1. **Model selection lost between Connect and sparkle.** In `src/components/ProjectSettings.tsx`, `handleConnect` (line ~169) calls `setModel(list[0])` to auto-select the first model returned by `/models`, but never calls the persist function. `useCompletion.isConfigured` reads from the persisted `ProjectRecord.completionSettings.model`, so it sees an empty string and the sparkle button refuses to fire with "didn't pick a model" — even though the dropdown visibly shows the model in local React state.
2. **Sparkle dialog shows a different UI than Settings.** `AiSetupDialog` wraps `AiProviderStep` (the onboarding component): a plain text input labeled "Model (optional)". The full Settings page has preset + URL + Connect + `/models`-populated dropdown + API key. The two surfaces disagree on both UI and validation semantics (the field is labeled optional, but `useCompletion` requires it for custom providers).

These are symptoms of a broader pattern. Across the app, settings use the shape:
- Read `ProjectRecord` via `useProject(id)`.
- Mirror fields into many `useState` hooks.
- Save on blur / change / mouseUp via ad-hoc paths.
- Different surfaces reimplement the same form.

Failure modes this shape produces:
- Local state diverges from storage when no blur event fires (bug 1).
- Every field reimplements its own commit policy, so bugs in one field don't get fixed in others.
- Any new UI surface that toggles a setting (command palette, keyboard shortcut, status-bar menu) duplicates the mirror-and-save dance.

## Non-goals

- No global state library (Zustand, Redux, Context for settings). `useProject` + IndexedDB is already the store; layering on top buys nothing.
- No rewrite of non-LLM settings cards (Git sync, validation, experimental flags). The new primitives will be available to them; adoption is opportunistic.
- No changes to Yjs, the sync worker, frontier session, or the health probe.
- No IndexedDB schema migration. `CompletionSettings` shape is unchanged.

## Architecture

Three layers.

### Layer 1 — Data (generalize what exists)

`useProject(id)` remains the single read path. Writes go through one race-safe hook:

```
useSaveProjectPatch(id: string): (patch: ProjectPatch) => Promise<void>
```

Where `ProjectPatch` is either `Partial<ProjectRecord>` or `{ completionSettings: Partial<CompletionSettings> }` for nested merges. Internally it does the same read-latest-from-IDB → shallow-merge → write-back pattern as today's `useSaveCompletionSettings`. No other call site invokes `updateProject` directly.

`useSaveCompletionSettings` becomes a thin wrapper on top during migration so onboarding-checklist code keeps working without edits; it can be removed once call sites migrate.

Any future "toggle this setting from elsewhere" (palette, shortcut, URL trigger) calls `useSaveProjectPatch` and all open `LlmSettingsForm` instances rerender through `useProject`. No pub/sub bus needed — IDB write + `useProject` refresh is the propagation mechanism.

### Layer 2 — Form primitive (new)

A single core hook with typed wrappers for common input patterns:

```
useSettingField<T>({
  source: T,              // current persisted value from project record
  save: (v: T) => Promise<void>,
}): {
  value: T,               // optimistic local value
  setValue: (v: T) => void,
  commit: () => Promise<void>,
  saving: boolean,
  savedFlash: boolean,
}
```

Thin wrappers: `useTextField` (commit on blur and Enter), `useToggleField` (commit on change), `useSelectField` (commit on change), `useSliderField` (commit on mouseUp).

Rules the hook enforces:
- `setValue` never writes — it updates local state only and marks the field "dirty".
- `commit` always writes through `save`, then clears the dirty flag.
- When `source` changes externally and the field is **not dirty**, local value syncs to the new source.
- When `source` changes externally and the field **is dirty**, the external change is ignored until the user commits or the component unmounts. The user's in-progress edit wins.
- `savedFlash` pulses true for ~1.5s after a successful commit.

This is where today's "no blur event → no write" bug class dies: every field has an explicit `commit()`, and compound handlers (like `handleConnect` that also needs to persist a derived field) call `commit()` rather than inventing their own save path.

### Layer 3 — Feature form (new, shared)

```
<LlmSettingsForm project={project} compact={false} onUpdated={...} />
```

One component used by all three current surfaces:
- `ProjectSettings` page — default (`compact={false}`): shows provider radio, preset, URL, API key, model dropdown, max tokens, temperature, health penalty, system prompt.
- `AiSetupDialog` — `compact={true}`: shows provider radio, preset, URL, API key, model. Hides sliders and system prompt. "Full settings →" link remains.
- Onboarding checklist — replaces `AiProviderStep` with `<LlmSettingsForm compact />`.

No "Save" button anywhere in the form. Every field commits on its natural event.

#### Auto-connect and model autoselect

No explicit "Connect" button. The `/models` fetch is a side-effect of the URL (or API key, or preset) commit:

- When the URL field commits (blur or preset selection), and provider is custom, fire `fetchModels(endpoint, apiKey)`.
- When the API key field commits, if URL is set and we have not yet connected successfully, re-fire the fetch (many providers need the key before `/models` returns).
- When the preset selector changes, the URL is updated in one compound action — set new URL, commit it, trigger the fetch. Preset change also clears any stale model list and any "connected" indicator so the UI doesn't carry models across providers.
- While a fetch is in flight, show a small spinner inline under the URL (replaces what the Connect button communicated). On success, show "Connected — N model(s)". On failure, show the error message inline.
- On successful fetch, if the current `model` field is empty, `commit(list[0])` automatically. If the user already has a model set (either from a prior session or a manual entry), leave their choice alone — don't clobber it.
- The model dropdown lets the user switch at any time. Changing the dropdown commits immediately.
- If the user types a URL that never returns models (404, CORS, unreachable), the model field falls back to a free-text input (same behavior as today's "Model (if not listed)" branch). Free-text commits on blur.

The UX goal: for the common path (paste a URL, optionally paste a key), the user does nothing else and the sparkle is live. For the uncommon path (exotic provider without `/models`), they get a text fallback without extra clicks.

### Validation parity

Extract to a pure function:

```
isAiConfigured(
  settings: CompletionSettings,
  session: FrontierSession | null,
  frontierAvailable: boolean,
): boolean
```

Replaces the inline check in `useCompletion.ts:44–46`. Used by:
- `useCompletion` gating (same place as today).
- `SparkleButton` disabled state (currently computed elsewhere; move to this).
- Inline "✓ Ready" / "Pick a model to enable AI" indicator in `LlmSettingsForm` under the model field.

By construction, the form and the gating cannot disagree about whether a configuration is valid.

## Bug fixes — how they land under this design

**Bug 1 (model not persisted after Connect):** there is no Connect button to skip a persist on. The URL commit triggers the fetch; on success, the first model is `commit()`-ed through the same `useSaveProjectPatch` path every other field uses. `useCompletion` then reads the fresh record. The divergent "local setModel without save" path is gone.

**Bug 2 (dialog shows different UI):** `AiSetupDialog` body becomes `<LlmSettingsForm project compact />`. The "Model (optional)" label is gone — the model field shares labeling with the full form, and `isAiConfigured`'s inline indicator tells the user exactly what's missing.

## File-by-file map

**New:**
- `src/hooks/useSaveProjectPatch.ts`
- `src/hooks/useSettingField.ts` (core + typed wrappers)
- `src/components/settings/LlmSettingsForm.tsx`
- `src/lib/completion/is-configured.ts`

**Modified:**
- `src/components/ProjectSettings.tsx` — replace the "Advanced LLM settings" `<details>` block (lines ~249–425) with `<LlmSettingsForm project />`. Drop the local `useState` hooks for provider/endpoint/apiKey/model/presetId/maxTokens/temperature/llmHealthPenalty and the `handleConnect` / `handlePresetChange` helpers.
- `src/components/AiSetupDialog.tsx` — replace `<AiProviderStep>` with `<LlmSettingsForm compact />`.
- `src/hooks/useCompletion.ts` — replace inline `isConfigured` with call to `isAiConfigured`.
- `src/components/SparkleButton.tsx` (and its caller in `EditorTable.tsx`) — compute disabled state via `isAiConfigured`.
- Wherever `AiProviderStep` is used by the onboarding checklist — swap for `<LlmSettingsForm compact />`. If `AiProviderStep` has no other callers after the dialog swap, delete it.

**Unchanged:** `src/hooks/useCompletionSettings.ts` stays and becomes a wrapper around `useSaveProjectPatch` during migration.

## Testing

**Unit (vitest):**
- `isAiConfigured` truth table: provider ∈ {frontier, custom} × session ∈ {present, null} × model ∈ {set, empty} × frontierAvailable ∈ {true, false}. Lock the current behavior: custom requires both endpoint and model; frontier requires session and frontier-available.
- `useSaveProjectPatch`: two concurrent patches touching different fields result in a final record with both merges applied (no lost write).
- `useSettingField`: (a) `setValue` alone does not call `save`; (b) `commit` calls `save` with current local value and clears dirty; (c) external `source` change while clean updates local value; (d) external `source` change while dirty does not overwrite local value until after next `commit`.

**E2E (Playwright, extend `e2e/` specs):**
- Custom endpoint golden path: open settings → switch to Custom → enter URL → blur → assert auto-connect spinner → assert model auto-selected and persisted (reload page, dropdown still set, IDB record has model) → return to editor → click sparkle → assert completion actually fires.
- User override: after auto-select, change dropdown to a different model → assert persisted → assert sparkle uses new model.
- Dialog parity: from editor, open sparkle dialog → assert fields match settings page LLM section (compact set) by role/label.
- Cross-surface consistency: change provider in dialog → close dialog → open settings → assert provider reflects change.
- `/models` failure path: enter an unreachable URL → assert inline error shown → assert free-text model fallback appears → type model id → blur → assert persisted.

## Migration / rollout

Pure UI and hook refactor. No data migration. Ship behind no flag — the new components are drop-in replacements, and the persisted shape is identical.

## Out of scope for this spec

- Generalizing non-LLM settings cards (Git sync, validation, experimental flags) onto `useSettingField`. They can adopt opportunistically; bug fixes there aren't the driver here.
- Command palette / keyboard shortcut / status-bar affordances for toggling AI provider. The architecture supports them — any call to `useSaveProjectPatch` works — but building them is a separate piece of work.
- Per-device vs per-project API key storage. Today API keys live in the `ProjectRecord`; that stays.
