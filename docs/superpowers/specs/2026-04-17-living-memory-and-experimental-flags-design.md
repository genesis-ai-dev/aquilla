# Living Memory + Experimental Flag Infrastructure

**Status:** Design
**Date:** 2026-04-17
**Scope:** Ship a read-only "Living Memory" view that surfaces what the AI has learned about the project (instructions, standards, recent examples) behind a project-level feature flag, and land the experimental-flag infrastructure this flag will be the first consumer of.

---

## Motivation

Today the project's AI configuration is scattered: `completionSettings.systemPrompt` is a textarea buried in Project Settings, `rules?` is a separate page, and the human-validated examples that the completion pipeline actually draws from live implicitly in `history[].examples`. A user who wants to answer "what does the AI actually know about my project, and why did it translate this way?" has no single place to look.

Meanwhile, several in-flight features from our ongoing health/trust workstream — rule-aware prompts, batch prediction via flash providers, agentic background review — are going to ship in stages, need real-project dogfooding before default-on, and will land faster if there's an established "ship-behind-flag" pattern. There isn't one today.

The product framing we've landed on is **"Living Memory"**: the AI isn't stateless — your project teaches it, and you can see what it has learned. That's the trust story in three words, and it's worth productizing. Shipping the Living Memory view alongside the flag infrastructure means the flag pattern is designed against a concrete consumer, not in the abstract.

## Goals

1. A **Living Memory** view at its own route that renders the project's current AI-relevant state (instructions, standards, recent examples) as a single destination, with copy that treats the AI as a thing that *remembers*, not a thing that *computes*.
2. A **liveness indicator** on that view showing the view is fresh — synced / updating / indexing — so the "alive" framing is visible, not just editorial.
3. A **project-scoped feature flag system** (`experimentalFlags` on `ProjectRecord`) with a typed registry, a `useFeatureFlag` hook, and an **Experimental** section in Project Settings that renders the registry automatically.
4. **Immediate persistence** for flag toggles (no Save button), with a **dirty-field warning** before navigating away if any non-flag field is unsaved — so the "toggle saved instantly, other fields need saving" split has clear UX affordances.
5. Living Memory ships gated by the `living-memory-view` flag, as a proof-of-pattern. Future work (rule-aware prompts, batch predict, semantic check, background agent, edit suggestions) lands as single-line registry additions.

## Non-Goals

- Editing Living Memory contents inline. Instructions remain editable only through Project Settings; rules through the Rules page. The view is read-only in v1.
- Cross-project memory, memory export, memory import.
- User-level / personal feature flags (`useLocalFlag`). Deferred until a UI-only flag actually needs one.
- Rule-aware prompt compilation itself (this spec ships the view of `systemPrompt` as-is, not the compiler). That's its own spec.
- Real background indexing. The liveness indicator reflects Yjs doc freshness and (once it exists) background-agent status, but this spec doesn't introduce any new background work.
- Flag-level access control (role gating, admin overrides). All project members see the same flags.

---

## Architecture Overview

```
┌─ ProjectRecord (existing, +1 field) ────────────────────────────────┐
│   id, name, sourceLanguage, targetLanguage, ...                      │
│   completionSettings  ← Instructions source                          │
│   rules?              ← Standards source                             │
│   experimentalFlags?: Record<string, boolean>   ← NEW                │
└──────────────────────────────────────────────────────────────────────┘
                   │                │                 │
                   ▼                ▼                 ▼
      ┌─────────────────┐   ┌────────────────┐  ┌─────────────────┐
      │ useProject      │   │ useRules       │  │ useFeatureFlag  │
      │ (existing)      │   │ (existing)     │  │ (NEW)           │
      └────────┬────────┘   └───────┬────────┘  └────────┬────────┘
               │                    │                    │
               └─────────┬──────────┘                    │
                         ▼                               │
          ┌──────────────────────────────┐               │
          │ LivingMemoryPage (NEW)        │◄──────────────┘ gates route
          │   LivenessIndicator           │
          │   InstructionsSection         │
          │   StandardsSection            │
          │   RecentExamplesSection       │
          └──────────────────────────────┘

      ┌────────────────────────────────────┐
      │ ProjectSettings.tsx (existing)      │
      │   + ExperimentalSection (NEW)       │
      │       renders FLAGS registry        │
      │       toggles persist immediately   │
      │   + dirty-field warn on navigate    │
      └────────────────────────────────────┘

      ┌────────────────────────────────────┐
      │ src/lib/features/flags.ts (NEW)     │
      │   FLAGS registry (typed)             │
      │   flagDefault(key), listFlags()      │
      └────────────────────────────────────┘
```

---

## Data model

One optional field added to `ProjectRecord` in `src/lib/parsers/types.ts`:

```ts
export interface ProjectRecord {
  // ...existing fields
  experimentalFlags?: Record<string, boolean>
}
```

- Optional; existing projects read as "no flags set" and fall back to registry defaults.
- Keys are arbitrary strings; the registry is the source of truth for which keys are recognized.
- Stored values for keys not in the registry are ignored on read (no migration needed when a flag is deleted from the registry).
- Syncs through the existing Yjs / `updateProject` path unchanged.

## Flag registry

New module `src/lib/features/flags.ts`:

```ts
export interface FlagDefinition {
  /** Human-readable name shown in settings. */
  label: string
  /** One-sentence description shown under the label. */
  description: string
  /** Default when the project has no value stored. */
  default: boolean
}

export const FLAGS = {
  "living-memory-view": {
    label: "Living Memory",
    description:
      "A view of what Codex has learned about this project — instructions, standards, and the examples the AI is drawing from.",
    default: false,
  },
  // Future flags land here as single-line additions:
  // "rule-aware-prompts":    { label: "…", description: "…", default: false },
  // "batch-predict":         { label: "…", description: "…", default: false },
  // "batch-semantic-check":  { label: "…", description: "…", default: false },
  // "background-agent":      { label: "…", description: "…", default: false },
  // "edit-suggestions":      { label: "…", description: "…", default: false },
} as const satisfies Record<string, FlagDefinition>

export type FlagKey = keyof typeof FLAGS

export function flagDefault(key: FlagKey): boolean {
  return FLAGS[key].default
}

export function listFlags(): { key: FlagKey; def: FlagDefinition }[] {
  return (Object.keys(FLAGS) as FlagKey[]).map((key) => ({ key, def: FLAGS[key] }))
}
```

- The registry is the authoritative list. The Experimental settings section renders it by iterating `listFlags()`; nothing else maintains a parallel list.
- Labels and descriptions live here — never duplicated in components.
- To ship a new flag: add one registry entry and use `useFeatureFlag("…")` at the consumer. To retire a flag: delete the entry and remove the call sites; stored values become no-ops.

## `useFeatureFlag` hook

New file `src/hooks/useFeatureFlag.ts`:

```ts
export function useFeatureFlag(key: FlagKey, project: ProjectRecord | null): boolean {
  if (!project) return flagDefault(key)
  const stored = project.experimentalFlags?.[key]
  return typeof stored === "boolean" ? stored : flagDefault(key)
}
```

- Takes the project explicitly (matches existing hook patterns like `useProjectPermissions`) rather than re-fetching — the caller already has `useProject`.
- Reading an unknown key returns `false` via `flagDefault`'s type signature (TypeScript prevents unknown keys at compile time).

For convenience, a second helper `setFeatureFlag(projectId, key, value)` wraps `updateProject` so toggle handlers don't each re-implement the merge:

```ts
export async function setFeatureFlag(
  projectId: string,
  key: FlagKey,
  value: boolean,
): Promise<void> {
  const p = await getProject(projectId)
  if (!p) return
  await updateProject({
    ...p,
    experimentalFlags: { ...(p.experimentalFlags ?? {}), [key]: value },
  })
}
```

---

## UI: Experimental settings section

Added to `src/components/ProjectSettings.tsx` as a new `<Card>` below the existing sections (AI provider, sync, etc.).

```
┌─ Experimental ─────────────────────────────────────────────────┐
│ These features are in active development. They may change,    │
│ move, or be removed. Expect rough edges.                      │
│                                                                │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ Living Memory                                      [ ○ → ] │ │
│ │ A view of what Codex has learned about this project —     │ │
│ │ instructions, standards, and the examples the AI is       │ │
│ │ drawing from.                                             │ │
│ └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Behavior:**

- Iterates `listFlags()` and renders one row per flag.
- Each row: label (bold), description (muted), `<Switch>` on the right.
- Toggle fires `setFeatureFlag(projectId, key, !current)` immediately — no Save button, no pending state.
- Toggle is optimistic: local state flips instantly, `updateProject` runs, Yjs propagation handles the rest.
- An empty registry renders the section with a "No experimental features available" placeholder — keeps the section in a consistent location.

**New shadcn dependency:** `Switch` component. Add via `npx shadcn@latest add switch` → creates `src/components/ui/switch.tsx`. No other ui/ components needed.

## UI: Dirty-field warning for non-flag settings

Because flag toggles persist immediately but the existing fields (name, language, system prompt, etc.) still use the Save button, we need a visible signal that some fields are unsaved and a confirm before the user loses them.

**Implementation in `ProjectSettings.tsx`:**

1. Track a `dirty` flag derived from "any non-flag form state differs from the loaded project." Small helper: compare current form state to the last loaded/saved snapshot on each render.
2. When `dirty`:
   - The Save button shows a filled/primary variant with an "• Unsaved changes" label (instead of disabled/ghost).
   - `useEffect` installs a `beforeunload` handler that returns a non-empty string, triggering the browser's leave-page confirmation.
   - React Router navigation blockers (`useBlocker` from react-router-dom v7) prompt a custom dialog before in-app navigation: "You have unsaved changes. Leave without saving?" with Stay / Leave.
3. Successful save clears the dirty snapshot.
4. Flag toggles do **not** set `dirty` — they persist themselves. The user can toggle flags freely without triggering the warning.

Copy for the confirm dialog:

> **Unsaved changes**
> You have unsaved changes to your project settings. If you leave, they'll be lost. (Experimental toggles are saved automatically.)
> [Stay] [Leave without saving]

The parenthetical is important — it teaches the split behavior in the moment it matters.

---

## UI: Living Memory view

### Route and navigation

- **Route:** `/project/:id/memory` registered in the router alongside existing project routes.
- **Nav link:** added to the ProjectSection of the sidebar (`SidebarProjectSection.tsx`), grouped with Rules, Comments, Snapshots. Label: "Living Memory." Icon: `lucide-react`'s `Brain` or `Sparkles` (pick whichever doesn't collide with existing icons; final choice during implementation).
- **Flag gating:**
  - When `useFeatureFlag("living-memory-view")` is `false`: the sidebar nav entry is hidden, and direct URL access (e.g. bookmark) redirects to `/project/:id` with a transient toast: "Living Memory is an experimental feature. Enable it in Project Settings."
  - When `true`: nav entry shown, route renders.

### Layout

Single-column page, header + stacked sections:

```
┌─ Living Memory ──────────────────────────────────────────────┐
│                                        ● Live · synced 2s ago│
│                                                              │
│ This is what Codex has learned about your project. It grows  │
│ with every edit, correction, and validation you make.        │
│                                                              │
│ ┌─ Instructions ───────────────────────────────────────────┐ │
│ │ What Codex has been told about your project.              │ │
│ │                                                           │ │
│ │ You are translating a project from English into Swahili. │ │
│ │ Match the tone and formality of the provided examples…   │ │
│ │                                                           │ │
│ │ [Edit in Project Settings →]                              │ │
│ └───────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌─ Standards ──────────────────────────────────────────────┐ │
│ │ Rules this project has accumulated. Codex follows these   │ │
│ │ and checks translations against them.                     │ │
│ │                                                           │ │
│ │ Must preserve (3)                                         │ │
│ │   • Numbers — Major                                       │ │
│ │   • Proper nouns — Major                                  │ │
│ │   • Section references — Minor                            │ │
│ │                                                           │ │
│ │ Must not contain (1)                                      │ │
│ │   • Archaic pronouns — Minor                              │ │
│ │                                                           │ │
│ │ [Manage in Rules →]                                       │ │
│ └───────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌─ Recent examples ────────────────────────────────────────┐ │
│ │ The human-validated translations Codex is drawing from   │ │
│ │ right now.                                               │ │
│ │                                                          │ │
│ │  Genesis 1:1 · validated by Ryder · 3 hours ago          │ │
│ │    In the beginning God created…                         │ │
│ │    Hapo mwanzo Mungu aliumba…                            │ │
│ │                                                          │ │
│ │  Genesis 1:2 · validated by Anna · yesterday              │ │
│ │    And the earth was without form…                       │ │
│ │    Nayo ardhi ilikuwa…                                   │ │
│ │                                                          │ │
│ │  … 8 more                                                │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Section content sources

| Section | Source | Rendering |
|---|---|---|
| Instructions | `project.completionSettings.systemPrompt` | Textual render with `{sourceLanguage}` / `{targetLanguage}` substituted (same substitution `buildPrompt` does) so users see resolved text, not the template. |
| Standards | `project.rules?` filtered to `enabled === true` | Grouped by `check.type`: `source-target-match` → "Must preserve"; `source-requires-target` → "Target must include when source matches"; `target-forbids` → "Must not contain." Severity shown as a badge. |
| Recent examples | Last N (N=10) human-validated cells across the project, sorted by validation timestamp desc | Query the Yjs doc for cells where `validationStatus` is `"full"` or `"self"`; pull source/target, file name, validator, timestamp. |

For v1, "Recent examples" queries through the existing cells/files structures — no new derived index, no background job. If the query is expensive at large project scale, add a simple memoized selector hook (`useRecentValidatedExamples(projectId, 10)`) that recomputes on Yjs change.

### Liveness indicator

A pill in the top-right of the page header, next to the title.

**States:**

| State | Visual | Trigger |
|---|---|---|
| `live` (synced) | Green dot (static) + "Live · synced Xs ago" | Default. `Xs` from the most recent Yjs update in the project doc. |
| `updating` | Yellow dot (pulsing) + "Updating…" | Shown for 800ms after a Yjs update is received, then transitions back to `live`. |
| `indexing` | Blue dot (animated) + "Indexing…" | Reserved for future background-agent work. v1 includes the state in the component API but never activates it. |
| `offline` | Gray dot + "Offline" | When the Yjs provider reports disconnected. |

The "synced Xs ago" timestamp updates once per second via a simple interval while the page is mounted.

**Implementation sketch:**

```tsx
function LivenessIndicator({ projectId }: { projectId: string }) {
  const status = useYjsSyncStatus(projectId) // derives from existing provider events
  const lastUpdate = useYjsLastUpdate(projectId)
  const [state, setState] = useState<"live" | "updating" | "offline">("live")
  // Flash "updating" for 800ms on each Yjs update, else "live" / "offline" from status.
  // ...
}
```

`useYjsSyncStatus` / `useYjsLastUpdate` are thin wrappers over the y-sweet provider events (`sync`, `status`, `local-changes`) that the migration work is already exposing.

---

## Copy guidelines

Everything user-facing in Living Memory avoids technical prompt/LLM language. Enforced through the copy tables below; reviewers should check these during implementation.

| Say | Don't say |
|---|---|
| Living Memory | Compiled prompt / System prompt view |
| Instructions | System prompt |
| Standards | Rules (in Living Memory context; the Rules page itself keeps its name) |
| Recent examples | Few-shot examples / in-context examples |
| What Codex has learned | What's in the context window |
| Synced / Updating / Indexing | Cache valid / Stale / Rebuilding |
| "grows with every edit, correction, and validation" | "recomputed on config change" |

The Rules page label stays "Rules" — users already know it. Inside Living Memory we call those same entities "Standards" because that's the frame Living Memory presents. The "Manage in Rules →" link makes the connection explicit.

---

## Testing

### Unit

- **`useFeatureFlag`** — returns stored value when present, registry default when absent, registry default when project is null. Table-driven across all registered flags.
- **Flag registry integrity** — compile-time `satisfies Record<string, FlagDefinition>` covers shape; add a small runtime test asserting every registered flag has non-empty `label` and `description` (catches empty strings in PR review).
- **`setFeatureFlag`** — merges into existing `experimentalFlags`, doesn't drop unrelated flags, handles missing project gracefully.

### Component

- **Experimental section** — renders one row per registered flag; toggle flips `experimentalFlags` via `setFeatureFlag`; empty registry renders placeholder.
- **Dirty-field warning** — dirty state flips correctly on non-flag edits but not on flag toggles; Save button variant changes; `beforeunload` and `useBlocker` fire when dirty.
- **LivingMemoryPage** — renders all three sections when data present; shows per-section empty states when rules / examples / instructions are absent; redirects to project workspace when flag is off; sidebar link hidden when flag is off.
- **LivenessIndicator** — transitions `live` → `updating` → `live` on Yjs update; reflects `offline` when provider disconnects; "X seconds ago" label updates.

### Integration

- **End-to-end flag flow:** open settings → toggle Living Memory on → nav link appears → page loads → toggle off → nav link disappears → direct URL access redirects.
- **Dirty state:** edit project name (don't save) → toggle an experimental flag → navigate away → dialog appears mentioning the name change but not the flag.

No new E2E harness introduced; use the existing vitest + `@testing-library/react` setup.

---

## Migration / backward compatibility

- `experimentalFlags` is optional; projects without it read as empty and get registry defaults. No data migration.
- Projects that have stored values for a later-retired flag are unaffected — reads go through the registry and ignore unknown keys.
- Existing `systemPrompt` and `rules` fields are untouched. This spec introduces a new view onto existing data; removing Living Memory would remove only the new view + flag infrastructure.

---

## Sequencing

Intended as a single PR unless it grows past ~600 LOC, in which case split at the horizontal line:

1. Add `experimentalFlags` to `ProjectRecord` type.
2. Create `src/lib/features/flags.ts` registry + `flagDefault` / `listFlags`.
3. Create `src/hooks/useFeatureFlag.ts` + `setFeatureFlag`.
4. Add `Switch` shadcn component.
5. Add Experimental section to `ProjectSettings.tsx` (iterates registry, toggles persist immediately).
6. Add dirty-field tracking + `beforeunload` + `useBlocker` confirm dialog to `ProjectSettings.tsx`.

---

7. Create `src/components/LivingMemoryPage.tsx` with the three sections, reading from `useProject` + `useRules`.
8. Create `LivenessIndicator` component + thin Yjs status hooks.
9. Register `/project/:id/memory` route; add sidebar link in `SidebarProjectSection.tsx` gated by `useFeatureFlag`.
10. Tests for all of the above.

Landing 1–6 first gives us the infrastructure to ship later flagged features even before Living Memory itself is finished; 7–10 add the view.

## Open questions for implementation

- **Icon choice** for the sidebar entry. `Brain`, `Sparkles`, or `BookOpen` are all candidates. Defer to implementation pass and review together.
- **"Recent examples" query performance** at project scale. If scanning all cells on every page render is slow, add a memoized selector; don't preemptively build a derived Yjs index.
- **Liveness indicator's `indexing` state.** Shape the component API to accept this state now (so future agent work can flip to it without changing the component), but v1 never sets it. Confirm during code review that the API doesn't over-commit to agent-specific vocabulary.
