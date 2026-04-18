# Living Memory + Experimental Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only "Living Memory" view behind a project-scoped feature flag, and land the experimental-flag infrastructure it depends on — including a typed flag registry, a `useFeatureFlag` hook, an Experimental settings section with immediate-persist toggles, and a dirty-field navigation warning for the rest of Project Settings.

**Architecture:** One new optional field on `ProjectRecord` (`experimentalFlags: Record<string, boolean>`) stores toggle state and syncs through the existing Yjs / `updateProject` path. A typed registry in `src/lib/features/flags.ts` is the authoritative list; the Experimental settings section iterates it. Living Memory is a new route at `/project/:id/memory` rendering three read-only sections sourced from `completionSettings.systemPrompt`, enabled `rules`, and recent human-validated cells, with a liveness pill tracking freshness. Pure functions carry the logic; hooks are thin wrappers — matching the project's existing `deriveChecklistState` + `useSetupChecklist` pattern where only pure logic is unit-tested.

**Tech Stack:** Existing — React 19, TypeScript, React Router v7 (`useBlocker`), Tailwind 4, shadcn/ui, vitest, `@testing-library/react`, `fake-indexeddb`, Yjs. New — shadcn `Switch` component.

**Spec:** `docs/superpowers/specs/2026-04-17-living-memory-and-experimental-flags-design.md`

---

## File Structure

```
src/
├── lib/
│   ├── features/
│   │   ├── flags.ts                        # NEW: registry + flagDefault + listFlags
│   │   ├── flags.test.ts                   # NEW: registry integrity
│   │   ├── flag-selector.ts                # NEW: pure getFlagValue fn
│   │   └── flag-selector.test.ts           # NEW: TDD
│   └── parsers/
│       └── types.ts                        # MODIFY: +experimentalFlags field
├── hooks/
│   ├── useFeatureFlag.ts                   # NEW: hook wrapper + setFeatureFlag
│   ├── useFeatureFlag.test.ts              # NEW: setFeatureFlag merge behavior
│   ├── useLiveness.ts                      # NEW: deriveLivenessState + hook
│   └── useLiveness.test.ts                 # NEW: TDD for pure fn
├── components/
│   ├── ui/
│   │   └── switch.tsx                      # NEW: via shadcn add
│   ├── ProjectSettings.tsx                 # MODIFY: +Experimental section, dirty tracking
│   ├── project-settings/
│   │   ├── dirty.ts                        # NEW: pure isSettingsDirty fn
│   │   └── dirty.test.ts                   # NEW: TDD
│   ├── LivingMemoryPage.tsx                # NEW: route component
│   ├── living-memory/
│   │   ├── InstructionsSection.tsx         # NEW
│   │   ├── StandardsSection.tsx            # NEW
│   │   ├── RecentExamplesSection.tsx       # NEW
│   │   ├── LivenessIndicator.tsx           # NEW
│   │   ├── group-rules.ts                  # NEW: pure groupRulesByType fn
│   │   ├── group-rules.test.ts             # NEW: TDD
│   │   ├── recent-examples.ts              # NEW: pure selectRecentValidatedExamples fn
│   │   └── recent-examples.test.ts         # NEW: TDD
│   └── ProjectWorkspace.tsx                # MODIFY: +Living Memory nav item (flag-gated)
├── lib/store/
│   └── file-doc.ts                         # MODIFY: +collectRecentExampleCandidates helper
└── App.tsx                                 # MODIFY: +route for /project/:id/memory
```

---

### Task 1: Add `experimentalFlags` to `ProjectRecord`

**Files:**
- Modify: `src/lib/parsers/types.ts:57-80`

No test — pure type declaration. Existing integration tests catch any shape regressions.

- [ ] **Step 1: Add the field**

In `src/lib/parsers/types.ts`, inside the `ProjectRecord` interface, add immediately after `setupChecklistDismissed?: boolean` (around line 79):

```ts
  /**
   * Project-scoped toggles for in-development features. Keys are defined in
   * `src/lib/features/flags.ts`; unknown keys are ignored on read. Optional —
   * projects without this field fall back to registry defaults.
   */
  experimentalFlags?: Record<string, boolean>
```

- [ ] **Step 2: Verify type-check passes**

Run: `npx tsc -b --noEmit`
Expected: exit code 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/parsers/types.ts
git commit -m "feat(flags): add experimentalFlags field to ProjectRecord"
```

---

### Task 2: Flag registry module

**Files:**
- Create: `src/lib/features/flags.ts`
- Create: `src/lib/features/flags.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/features/flags.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { FLAGS, flagDefault, listFlags, type FlagKey } from "./flags"

describe("FLAGS registry", () => {
  it("registers living-memory-view flag", () => {
    expect(FLAGS).toHaveProperty("living-memory-view")
    expect(FLAGS["living-memory-view"].default).toBe(false)
  })

  it("every flag has a non-empty label and description", () => {
    for (const [key, def] of Object.entries(FLAGS)) {
      expect(def.label, `flag "${key}" label`).toBeTruthy()
      expect(def.description, `flag "${key}" description`).toBeTruthy()
    }
  })
})

describe("flagDefault", () => {
  it("returns the registered default for a known flag", () => {
    expect(flagDefault("living-memory-view")).toBe(false)
  })
})

describe("listFlags", () => {
  it("returns every registered flag", () => {
    const entries = listFlags()
    expect(entries.length).toBe(Object.keys(FLAGS).length)
    const keys = entries.map((e) => e.key as string)
    expect(keys).toContain("living-memory-view")
  })

  it("each entry includes key and def", () => {
    for (const entry of listFlags()) {
      expect(entry).toHaveProperty("key")
      expect(entry).toHaveProperty("def")
      expect(entry.def.label).toBeTruthy()
    }
  })
})

// Type-level sanity: FlagKey should exclude unknown strings.
// Uncommenting the next line should fail compilation.
// const _bad: FlagKey = "nonexistent-flag"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/features/flags.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `src/lib/features/flags.ts`:

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
} as const satisfies Record<string, FlagDefinition>

export type FlagKey = keyof typeof FLAGS

export function flagDefault(key: FlagKey): boolean {
  return FLAGS[key].default
}

export function listFlags(): { key: FlagKey; def: FlagDefinition }[] {
  return (Object.keys(FLAGS) as FlagKey[]).map((key) => ({ key, def: FLAGS[key] }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/features/flags.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/features/flags.ts src/lib/features/flags.test.ts
git commit -m "feat(flags): introduce experimental flag registry"
```

---

### Task 3: Flag selector (pure) + useFeatureFlag hook + setFeatureFlag

**Files:**
- Create: `src/lib/features/flag-selector.ts`
- Create: `src/lib/features/flag-selector.test.ts`
- Create: `src/hooks/useFeatureFlag.ts`
- Create: `src/hooks/useFeatureFlag.test.ts`

- [ ] **Step 1: Write failing test for pure selector**

Create `src/lib/features/flag-selector.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getFlagValue } from "./flag-selector"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    name: "Test",
    sourceLanguage: "en",
    targetLanguage: "sw",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

describe("getFlagValue", () => {
  it("returns registry default when project is null", () => {
    expect(getFlagValue(null, "living-memory-view")).toBe(false)
  })

  it("returns registry default when project has no experimentalFlags", () => {
    const p = makeProject()
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })

  it("returns registry default when flag not set on project", () => {
    const p = makeProject({ experimentalFlags: {} })
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })

  it("returns stored value when set to true", () => {
    const p = makeProject({ experimentalFlags: { "living-memory-view": true } })
    expect(getFlagValue(p, "living-memory-view")).toBe(true)
  })

  it("returns stored value when set to false explicitly", () => {
    const p = makeProject({ experimentalFlags: { "living-memory-view": false } })
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })

  it("ignores non-boolean stored values and falls back to default", () => {
    // Simulate legacy/corrupt data: a non-boolean slipped into the record.
    const p = makeProject({
      experimentalFlags: { "living-memory-view": "true" as unknown as boolean },
    })
    expect(getFlagValue(p, "living-memory-view")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/features/flag-selector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the selector**

Create `src/lib/features/flag-selector.ts`:

```ts
import type { ProjectRecord } from "@/lib/parsers/types"
import { flagDefault, type FlagKey } from "./flags"

/**
 * Resolve a flag's effective value for a project. Returns the stored boolean
 * if present, else the registry default. Non-boolean stored values (should
 * be impossible through the typed API but can occur with legacy data) are
 * treated as absent.
 */
export function getFlagValue(project: ProjectRecord | null, key: FlagKey): boolean {
  if (!project) return flagDefault(key)
  const stored = project.experimentalFlags?.[key]
  return typeof stored === "boolean" ? stored : flagDefault(key)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/features/flag-selector.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write failing test for setFeatureFlag**

Create `src/hooks/useFeatureFlag.test.ts`:

```ts
import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach } from "vitest"
import type { ProjectRecord } from "@/lib/parsers/types"
import { createProject, getProject } from "@/lib/store/project-index"
import { setFeatureFlag } from "./useFeatureFlag"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p-flag-test",
    name: "Test",
    sourceLanguage: "en",
    targetLanguage: "sw",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

describe("setFeatureFlag", () => {
  beforeEach(async () => {
    // fake-indexeddb resets per-test automatically with the auto-register, but
    // we create fresh records per test to keep things explicit.
    const p = await getProject("p-flag-test")
    if (p) {
      // no delete helper needed; overwrite in tests
    }
  })

  it("sets a flag on a project with no experimentalFlags", async () => {
    await createProject(makeProject())
    await setFeatureFlag("p-flag-test", "living-memory-view", true)
    const p = await getProject("p-flag-test")
    expect(p?.experimentalFlags?.["living-memory-view"]).toBe(true)
  })

  it("merges into existing experimentalFlags without clobbering", async () => {
    await createProject(
      makeProject({
        experimentalFlags: { "some-other-flag": true },
      }),
    )
    await setFeatureFlag("p-flag-test", "living-memory-view", true)
    const p = await getProject("p-flag-test")
    expect(p?.experimentalFlags).toEqual({
      "some-other-flag": true,
      "living-memory-view": true,
    })
  })

  it("overwrites an existing value for the same key", async () => {
    await createProject(
      makeProject({
        experimentalFlags: { "living-memory-view": true },
      }),
    )
    await setFeatureFlag("p-flag-test", "living-memory-view", false)
    const p = await getProject("p-flag-test")
    expect(p?.experimentalFlags?.["living-memory-view"]).toBe(false)
  })

  it("no-ops when project does not exist", async () => {
    // Does not throw, does not create.
    await setFeatureFlag("nonexistent-project", "living-memory-view", true)
    expect(await getProject("nonexistent-project")).toBeUndefined()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/hooks/useFeatureFlag.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the hook and setter**

Create `src/hooks/useFeatureFlag.ts`:

```ts
import { useMemo } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getProject, updateProject } from "@/lib/store/project-index"
import { getFlagValue } from "@/lib/features/flag-selector"
import type { FlagKey } from "@/lib/features/flags"

/**
 * Resolve a feature flag's current value for a project. The hook re-evaluates
 * whenever the project identity changes; consumers should already be reading
 * the project via `useProject` and passing it in (same pattern as
 * `useProjectPermissions`).
 */
export function useFeatureFlag(key: FlagKey, project: ProjectRecord | null): boolean {
  return useMemo(() => getFlagValue(project, key), [project, key])
}

/**
 * Persist a flag change to a project. Merges into any existing flags and is
 * a no-op when the project record is missing. Callers should treat this as
 * fire-and-forget; Yjs propagation handles the live update.
 */
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

- [ ] **Step 8: Run tests to verify all pass**

Run: `npx vitest run src/hooks/useFeatureFlag.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 9: Commit**

```bash
git add src/lib/features/flag-selector.ts src/lib/features/flag-selector.test.ts \
        src/hooks/useFeatureFlag.ts src/hooks/useFeatureFlag.test.ts
git commit -m "feat(flags): add getFlagValue, useFeatureFlag, setFeatureFlag"
```

---

### Task 4: Install shadcn `Switch` component

**Files:**
- Create (via shadcn): `src/components/ui/switch.tsx`

- [ ] **Step 1: Add the component via shadcn CLI**

Run: `npx shadcn@latest add switch`

When prompted about overwriting, decline. Expected output: "✔ Created 1 file: src/components/ui/switch.tsx" (or similar).

- [ ] **Step 2: Verify the file exists and type-checks**

Run: `ls src/components/ui/switch.tsx && npx tsc -b --noEmit`
Expected: file path printed, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/switch.tsx package.json package-lock.json
git commit -m "chore(ui): add shadcn Switch component"
```

If `shadcn` also adds a Radix Switch dependency to `package.json`, include it in the commit; if no dependency change occurred, commit only the new component file.

---

### Task 5: Add Experimental section to Project Settings

**Files:**
- Modify: `src/components/ProjectSettings.tsx` (add section near the bottom of the form)

No unit test (matches codebase convention — component rendering is verified manually for this repo).

- [ ] **Step 1: Add imports to ProjectSettings**

At the top of `src/components/ProjectSettings.tsx`, add:

```ts
import { Switch } from "@/components/ui/switch"
import { listFlags } from "@/lib/features/flags"
import { useFeatureFlag, setFeatureFlag } from "@/hooks/useFeatureFlag"
```

- [ ] **Step 2: Add the Experimental card**

Add a new `<Card>` just above the existing final Save button / footer of the form. The exact insertion point is after the last existing `<Card>` in the JSX. The card iterates the registry and renders one row per flag:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Experimental</CardTitle>
  </CardHeader>
  <CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">
      These features are in active development. They may change, move, or be
      removed. Expect rough edges.
    </p>
    {listFlags().length === 0 ? (
      <p className="text-sm text-muted-foreground">
        No experimental features available.
      </p>
    ) : (
      <div className="space-y-3">
        {listFlags().map(({ key, def }) => (
          <ExperimentalFlagRow
            key={key}
            flagKey={key}
            label={def.label}
            description={def.description}
            project={project}
          />
        ))}
      </div>
    )}
  </CardContent>
</Card>
```

Then add this helper component inside the same file, below the main `ProjectSettings` component:

```tsx
function ExperimentalFlagRow({
  flagKey,
  label,
  description,
  project,
}: {
  flagKey: Parameters<typeof useFeatureFlag>[0]
  label: string
  description: string
  project: ProjectRecord | null
}) {
  const value = useFeatureFlag(flagKey, project)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const checked = optimistic ?? value

  const handleChange = async (next: boolean) => {
    if (!project) return
    setOptimistic(next)
    try {
      await setFeatureFlag(project.id, flagKey, next)
      setOptimistic(null)
    } catch {
      setOptimistic(null) // revert to store value on failure
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={handleChange}
        aria-label={`Toggle ${label}`}
      />
    </div>
  )
}
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc -b --noEmit && npm run lint`
Expected: exit code 0.

- [ ] **Step 4: Manually verify in dev**

Run: `npm run dev`

In the browser:
1. Open any project, navigate to Settings.
2. Scroll to the Experimental section. Confirm it renders with one row (Living Memory) and a `p` of explanatory text.
3. Toggle the switch — the UI flips immediately.
4. Refresh the page. Confirm the toggle state is persisted.
5. Open a second browser tab on the same project, toggle in one, confirm it propagates to the other within a second or two (Yjs path).

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectSettings.tsx
git commit -m "feat(settings): add Experimental section with feature flag toggles"
```

---

### Task 6: Dirty-field tracking + navigation warning

**Files:**
- Create: `src/components/project-settings/dirty.ts`
- Create: `src/components/project-settings/dirty.test.ts`
- Modify: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Write failing test for pure dirty-state function**

Create `src/components/project-settings/dirty.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { isSettingsDirty, type SettingsFormSnapshot } from "./dirty"

function snap(overrides: Partial<SettingsFormSnapshot> = {}): SettingsFormSnapshot {
  return {
    name: "Project",
    sourceLanguage: "en",
    targetLanguage: "sw",
    username: "ryder",
    provider: "frontier",
    endpoint: "",
    apiKey: "",
    model: "",
    maxTokens: 512,
    temperature: 0.3,
    systemPrompt: "Translate carefully.",
    llmHealthPenalty: 0.1,
    autoSyncEnabled: false,
    autoSyncInterval: 5,
    ...overrides,
  }
}

describe("isSettingsDirty", () => {
  it("returns false when form state matches loaded snapshot", () => {
    const loaded = snap()
    const current = snap()
    expect(isSettingsDirty(loaded, current)).toBe(false)
  })

  it("returns true when name differs", () => {
    expect(isSettingsDirty(snap(), snap({ name: "Changed" }))).toBe(true)
  })

  it("returns true when systemPrompt differs", () => {
    expect(isSettingsDirty(snap(), snap({ systemPrompt: "New" }))).toBe(true)
  })

  it("returns true when a numeric field differs", () => {
    expect(isSettingsDirty(snap(), snap({ maxTokens: 1024 }))).toBe(true)
  })

  it("returns false when loaded snapshot is null (initial load)", () => {
    expect(isSettingsDirty(null, snap())).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/project-settings/dirty.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure function**

Create `src/components/project-settings/dirty.ts`:

```ts
import type { CompletionProvider } from "@/lib/parsers/types"

/**
 * Snapshot of every non-flag field in the ProjectSettings form. Used to
 * compare loaded-from-store state against in-flight edits. Experimental
 * flags are deliberately excluded — they persist immediately on toggle
 * and so are never part of "unsaved changes."
 */
export interface SettingsFormSnapshot {
  name: string
  sourceLanguage: string
  targetLanguage: string
  username: string
  provider: CompletionProvider
  endpoint: string
  apiKey: string
  model: string
  maxTokens: number
  temperature: number
  systemPrompt: string
  llmHealthPenalty: number
  autoSyncEnabled: boolean
  autoSyncInterval: number
}

export function isSettingsDirty(
  loaded: SettingsFormSnapshot | null,
  current: SettingsFormSnapshot,
): boolean {
  if (!loaded) return false
  const keys = Object.keys(loaded) as (keyof SettingsFormSnapshot)[]
  for (const k of keys) {
    if (loaded[k] !== current[k]) return true
  }
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/project-settings/dirty.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Wire dirty tracking into ProjectSettings**

In `src/components/ProjectSettings.tsx`:

Add imports:

```ts
import { useBlocker } from "react-router-dom"
import { isSettingsDirty, type SettingsFormSnapshot } from "./project-settings/dirty"
```

Inside the component, after the existing `useState` declarations, track a snapshot of what was loaded:

```ts
const [loadedSnapshot, setLoadedSnapshot] = useState<SettingsFormSnapshot | null>(null)
```

In the existing `useEffect` that loads the project and calls `set*` for each field (around line 66+), after all setters fire, capture the snapshot:

```ts
setLoadedSnapshot({
  name: p.name,
  sourceLanguage: p.sourceLanguage,
  targetLanguage: p.targetLanguage,
  username: p.username || "local",
  provider: p.completionSettings ? resolveProvider(p.completionSettings) : "frontier",
  endpoint: p.completionSettings?.endpoint ?? "",
  apiKey: p.completionSettings?.apiKey ?? "",
  model: p.completionSettings?.model ?? "",
  maxTokens: p.completionSettings?.maxTokens ?? 512,
  temperature: p.completionSettings?.temperature ?? 0.3,
  systemPrompt: p.completionSettings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: p.completionSettings?.llmHealthPenalty ?? 0.1,
  autoSyncEnabled: p.syncSettings?.autoSync?.enabled ?? false,
  autoSyncInterval: p.syncSettings?.autoSync?.intervalMinutes ?? 5,
})
```

Derive the current snapshot + dirty state (add near other derived values, before the return):

```ts
const currentSnapshot: SettingsFormSnapshot = {
  name, sourceLanguage, targetLanguage, username,
  provider, endpoint, apiKey, model, maxTokens, temperature,
  systemPrompt, llmHealthPenalty,
  autoSyncEnabled, autoSyncInterval,
}
const dirty = isSettingsDirty(loadedSnapshot, currentSnapshot)
```

Install the `beforeunload` handler:

```ts
useEffect(() => {
  if (!dirty) return
  const handler = (e: BeforeUnloadEvent) => {
    e.preventDefault()
    e.returnValue = ""
  }
  window.addEventListener("beforeunload", handler)
  return () => window.removeEventListener("beforeunload", handler)
}, [dirty])
```

Install the in-app navigation blocker:

```ts
const blocker = useBlocker(dirty)
```

Render a confirmation dialog when `blocker.state === "blocked"` (place inside the main return, above or below the form):

```tsx
{blocker.state === "blocked" && (
  <Dialog open onOpenChange={() => blocker.reset?.()}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Unsaved changes</DialogTitle>
        <DialogDescription>
          You have unsaved changes to your project settings. If you leave,
          they'll be lost. Experimental toggles are saved automatically.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => blocker.reset?.()}>
          Stay
        </Button>
        <Button variant="destructive" onClick={() => blocker.proceed?.()}>
          Leave without saving
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)}
```

(Add `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` to the imports from `@/components/ui/dialog` if not already present.)

Update the Save button to surface dirty-state:

```tsx
<Button onClick={handleSave} variant={dirty ? "default" : "outline"}>
  {dirty ? "Save (unsaved changes)" : "Save"}
</Button>
```

In the existing save handler, after the successful `updateProject(...)` call, reset the snapshot so `dirty` goes back to `false`:

```ts
setLoadedSnapshot(currentSnapshot)
```

- [ ] **Step 6: Type-check and lint**

Run: `npx tsc -b --noEmit && npm run lint`
Expected: exit code 0.

- [ ] **Step 7: Manually verify in dev**

Run: `npm run dev`

1. Open project Settings. Save button reads "Save" and is outline variant.
2. Edit the project name. Save button changes to "Save (unsaved changes)", filled variant.
3. Click the sidebar Files nav — the "Unsaved changes" dialog appears.
4. Click Stay — the dialog closes, you remain on Settings.
5. Try to close the tab — browser prompts to confirm.
6. Save — button reverts to "Save" (outline).
7. Toggle the Experimental flag — Save button stays on "Save" (outline). Navigate away — no dialog.

Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/components/ProjectSettings.tsx src/components/project-settings/dirty.ts src/components/project-settings/dirty.test.ts
git commit -m "feat(settings): track dirty state and warn before losing unsaved changes"
```

---

### Task 7: Living Memory — pure helpers

**Files:**
- Create: `src/components/living-memory/group-rules.ts`
- Create: `src/components/living-memory/group-rules.test.ts`
- Create: `src/components/living-memory/recent-examples.ts`
- Create: `src/components/living-memory/recent-examples.test.ts`

- [ ] **Step 1: Write failing tests for groupRulesByType**

Create `src/components/living-memory/group-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { groupRulesByType, type StandardGroup } from "./group-rules"
import type { TranslationRule } from "@/lib/parsers/types"

function makeRule(overrides: Partial<TranslationRule> & { id: string; check: TranslationRule["check"] }): TranslationRule {
  return {
    name: "Test Rule", description: "", severity: "major", source: "user",
    scope: "project", enabled: true, createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("groupRulesByType", () => {
  it("returns empty groups when no rules are provided", () => {
    const result = groupRulesByType([])
    expect(result.mustPreserve).toEqual([])
    expect(result.mustInclude).toEqual([])
    expect(result.mustNotContain).toEqual([])
  })

  it("filters out disabled rules", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", enabled: false, check: { type: "target-forbids", targetPattern: "foo" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustNotContain).toEqual([])
  })

  it("groups source-target-match as mustPreserve", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", name: "Numbers", check: { type: "source-target-match", pattern: "\\d+" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustPreserve).toHaveLength(1)
    expect(result.mustPreserve[0].name).toBe("Numbers")
  })

  it("groups source-requires-target as mustInclude", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", check: { type: "source-requires-target", sourcePattern: "yo", targetPattern: "ya" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustInclude).toHaveLength(1)
  })

  it("groups target-forbids as mustNotContain", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "thee|thou" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustNotContain).toHaveLength(1)
  })

  it("preserves rule order within each group", () => {
    const rules: TranslationRule[] = [
      makeRule({ id: "a", name: "A", check: { type: "target-forbids", targetPattern: "x" } }),
      makeRule({ id: "b", name: "B", check: { type: "target-forbids", targetPattern: "y" } }),
    ]
    const result = groupRulesByType(rules)
    expect(result.mustNotContain.map((r) => r.name)).toEqual(["A", "B"])
  })
})
```

Note: `StandardGroup` is imported but not used in tests; it's exported as a typename for consumer components.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/living-memory/group-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement groupRulesByType**

Create `src/components/living-memory/group-rules.ts`:

```ts
import type { TranslationRule } from "@/lib/parsers/types"

export interface StandardGroup {
  mustPreserve: TranslationRule[]
  mustInclude: TranslationRule[]
  mustNotContain: TranslationRule[]
}

/**
 * Group enabled rules by check type for the Living Memory Standards section.
 * Disabled rules are excluded.
 */
export function groupRulesByType(rules: TranslationRule[]): StandardGroup {
  const enabled = rules.filter((r) => r.enabled)
  const group: StandardGroup = {
    mustPreserve: [],
    mustInclude: [],
    mustNotContain: [],
  }
  for (const rule of enabled) {
    switch (rule.check.type) {
      case "source-target-match":
        group.mustPreserve.push(rule)
        break
      case "source-requires-target":
        group.mustInclude.push(rule)
        break
      case "target-forbids":
        group.mustNotContain.push(rule)
        break
    }
  }
  return group
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/living-memory/group-rules.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write failing tests for selectRecentValidatedExamples**

Create `src/components/living-memory/recent-examples.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CellHistoryEntry } from "@/lib/parsers/types"
import { selectRecentValidatedExamples } from "./recent-examples"

function makeCell(overrides: Partial<CellData> & { id: string; history?: CellHistoryEntry[] }): CellData {
  return {
    original: "source",
    translated: "target",
    context: "",
    group: "",
    type: "text",
    originalHtml: undefined,
    status: "validated",
    validationStatus: "full",
    activeValidators: ["ryder"],
    history: [],
    threads: [],
    ...overrides,
  }
}

function makeEntry(timestamp: string, author = "ryder"): CellHistoryEntry {
  return { timestamp, value: "target", source: "human", author, validated: true }
}

describe("selectRecentValidatedExamples", () => {
  it("returns empty array when no cells are provided", () => {
    expect(selectRecentValidatedExamples([], 10)).toEqual([])
  })

  it("includes cells with validationStatus=full", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "full", history: [makeEntry("2026-04-17T10:00:00Z")] }),
    ]
    const result = selectRecentValidatedExamples(cells, 10)
    expect(result).toHaveLength(1)
    expect(result[0].cellId).toBe("c1")
  })

  it("includes cells with validationStatus=self", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "self", history: [makeEntry("2026-04-17T10:00:00Z")] }),
    ]
    expect(selectRecentValidatedExamples(cells, 10)).toHaveLength(1)
  })

  it("excludes unvalidated cells", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "none" }),
      makeCell({ id: "c2", validationStatus: "empty" }),
    ]
    expect(selectRecentValidatedExamples(cells, 10)).toEqual([])
  })

  it("sorts by most recent history timestamp, descending", () => {
    const cells = [
      makeCell({ id: "older", validationStatus: "full", history: [makeEntry("2026-04-01T00:00:00Z")] }),
      makeCell({ id: "newer", validationStatus: "full", history: [makeEntry("2026-04-15T00:00:00Z")] }),
    ]
    const result = selectRecentValidatedExamples(cells, 10)
    expect(result.map((r) => r.cellId)).toEqual(["newer", "older"])
  })

  it("limits the result to N", () => {
    const cells = Array.from({ length: 20 }, (_, i) =>
      makeCell({
        id: `c${i}`,
        validationStatus: "full",
        history: [makeEntry(`2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`)],
      }),
    )
    const result = selectRecentValidatedExamples(cells, 5)
    expect(result).toHaveLength(5)
    // Most recent first — c19 (day 20) should be first.
    expect(result[0].cellId).toBe("c19")
  })

  it("handles cells with no history (uses fallback sort key)", () => {
    const cells = [
      makeCell({ id: "c1", validationStatus: "full", history: [] }),
    ]
    const result = selectRecentValidatedExamples(cells, 10)
    expect(result).toHaveLength(1)
  })
})

// Note: the selector accepts anything with the fields it reads (id, original,
// translated, validationStatus, history). Callers may pass `CellData` (from
// the editor hook) or lightweight structural objects (from
// collectRecentExampleCandidates). The test uses `CellData` to stay close to
// the primary caller's shape.
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/components/living-memory/recent-examples.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement selectRecentValidatedExamples**

Create `src/components/living-memory/recent-examples.ts`:

```ts
import type { CellData } from "@/hooks/useCells"

export interface RecentExample {
  cellId: string
  source: string
  target: string
  validatedAt: string // ISO; empty string if no history available
  author: string       // last human edit author if available
}

/**
 * Return the N most recently validated cells across the project, sorted by
 * most-recent validation timestamp descending.
 *
 * "Validated" means validationStatus is "full" (consensus reached) or "self"
 * (current user has validated). Empty and un-validated cells are excluded.
 * Cells with no history are included but sorted to the bottom.
 */
export function selectRecentValidatedExamples(cells: CellData[], limit: number): RecentExample[] {
  const validated = cells.filter(
    (c) => c.validationStatus === "full" || c.validationStatus === "self",
  )

  const examples: RecentExample[] = validated.map((c) => {
    const lastEntry = c.history[c.history.length - 1]
    return {
      cellId: c.id,
      source: c.original,
      target: c.translated,
      validatedAt: lastEntry?.timestamp ?? "",
      author: lastEntry?.author ?? "",
    }
  })

  examples.sort((a, b) => b.validatedAt.localeCompare(a.validatedAt))
  return examples.slice(0, limit)
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/components/living-memory/recent-examples.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 9: Commit**

```bash
git add src/components/living-memory/group-rules.ts src/components/living-memory/group-rules.test.ts \
        src/components/living-memory/recent-examples.ts src/components/living-memory/recent-examples.test.ts
git commit -m "feat(living-memory): pure helpers for grouping rules and selecting examples"
```

---

### Task 8: Liveness state derivation + hook

**Files:**
- Create: `src/hooks/useLiveness.ts`
- Create: `src/hooks/useLiveness.test.ts`
- Create: `src/components/living-memory/LivenessIndicator.tsx`

- [ ] **Step 1: Write failing test for deriveLivenessState**

Create `src/hooks/useLiveness.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { deriveLivenessState, formatSyncedAgo } from "./useLiveness"

describe("deriveLivenessState", () => {
  it("returns 'offline' when online=false regardless of recency", () => {
    expect(deriveLivenessState({ online: false, lastUpdate: 1000, now: 1500 })).toBe("offline")
  })

  it("returns 'updating' when a recent update is within the flash window", () => {
    // Flash window is 800ms; 500ms ago is within it.
    expect(deriveLivenessState({ online: true, lastUpdate: 1000, now: 1500 })).toBe("updating")
  })

  it("returns 'live' when last update is outside the flash window", () => {
    expect(deriveLivenessState({ online: true, lastUpdate: 1000, now: 2000 })).toBe("live")
  })

  it("returns 'live' when lastUpdate is null", () => {
    expect(deriveLivenessState({ online: true, lastUpdate: null, now: 1000 })).toBe("live")
  })
})

describe("formatSyncedAgo", () => {
  it("says 'just now' when within 5 seconds", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 3000 })).toBe("just now")
  })

  it("formats seconds when under a minute", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 31000 })).toBe("30s ago")
  })

  it("formats minutes when under an hour", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 1000 + 120_000 })).toBe("2m ago")
  })

  it("formats hours beyond that", () => {
    expect(formatSyncedAgo({ lastUpdate: 1000, now: 1000 + 3 * 3600_000 })).toBe("3h ago")
  })

  it("returns empty string when lastUpdate is null", () => {
    expect(formatSyncedAgo({ lastUpdate: null, now: 1000 })).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useLiveness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement deriveLivenessState + formatSyncedAgo + useLiveness**

Create `src/hooks/useLiveness.ts`:

```ts
import { useEffect, useRef, useState } from "react"

export type LivenessState = "live" | "updating" | "indexing" | "offline"

/** Flash window after a Yjs update during which we show "updating". */
const UPDATING_WINDOW_MS = 800

export function deriveLivenessState(input: {
  online: boolean
  lastUpdate: number | null
  now: number
}): LivenessState {
  if (!input.online) return "offline"
  if (input.lastUpdate != null && input.now - input.lastUpdate < UPDATING_WINDOW_MS) {
    return "updating"
  }
  return "live"
}

export function formatSyncedAgo(input: {
  lastUpdate: number | null
  now: number
}): string {
  if (input.lastUpdate == null) return ""
  const delta = input.now - input.lastUpdate
  if (delta < 5_000) return "just now"
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  return `${Math.floor(delta / 3600_000)}h ago`
}

/**
 * Track liveness for the current project. v1 uses:
 *  - `navigator.onLine` + window online/offline events for offline detection
 *  - a caller-provided `bumpedAt` counter that advances whenever upstream
 *    state changes (e.g., project or rules identity change) as the proxy
 *    for "we just received an update"
 *
 * When the y-sweet provider's sync events are exposed project-wide, swap
 * `bumpedAt` for a subscription to those events. The pure state derivation
 * above does not change.
 */
export function useLiveness(bumpedAt: number): {
  state: LivenessState
  label: string
} {
  const [online, setOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  )
  const [now, setNow] = useState(() => Date.now())

  // Track the latest bump timestamp so we can compute "X seconds ago."
  const lastUpdateRef = useRef<number | null>(null)
  useEffect(() => {
    if (bumpedAt > 0) {
      lastUpdateRef.current = Date.now()
      setNow(Date.now()) // force re-evaluation for immediate flash
    }
  }, [bumpedAt])

  // Tick once per second while mounted so "X seconds ago" updates and
  // the UPDATING_WINDOW transition fires.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Offline/online listeners
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])

  const state = deriveLivenessState({
    online,
    lastUpdate: lastUpdateRef.current,
    now,
  })

  const agoLabel = formatSyncedAgo({ lastUpdate: lastUpdateRef.current, now })

  let label: string
  switch (state) {
    case "offline":
      label = "Offline"
      break
    case "updating":
      label = "Updating…"
      break
    case "indexing":
      label = "Indexing…"
      break
    case "live":
      label = agoLabel ? `Live · synced ${agoLabel}` : "Live"
      break
  }

  return { state, label }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useLiveness.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Implement the indicator component**

Create `src/components/living-memory/LivenessIndicator.tsx`:

```tsx
import { cn } from "@/lib/utils"
import type { LivenessState } from "@/hooks/useLiveness"

interface Props {
  state: LivenessState
  label: string
}

const DOT_CLASSES: Record<LivenessState, string> = {
  live: "bg-green-500",
  updating: "bg-yellow-500 animate-pulse",
  indexing: "bg-blue-500 animate-pulse",
  offline: "bg-muted-foreground",
}

export function LivenessIndicator({ state, label }: Props) {
  return (
    <div className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[state])} aria-hidden />
      <span>{label}</span>
    </div>
  )
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc -b --noEmit`
Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useLiveness.ts src/hooks/useLiveness.test.ts src/components/living-memory/LivenessIndicator.tsx
git commit -m "feat(living-memory): liveness state derivation and indicator"
```

---

### Task 9: Cross-file validated-example candidates (store helper)

Living Memory needs validated cells aggregated across *all* project files, but the existing `useCells(doc, username)` hook binds to a single file's Y.Doc. The store layer already has a one-shot aggregator (`collectValidatedPairs` in `src/lib/store/file-doc.ts`) that returns only source/target. We need a richer shape: id, source, target, last-history timestamp, last-history author, and a `validationStatus`-compatible marker.

Add a sibling helper in the same file.

**Files:**
- Modify: `src/lib/store/file-doc.ts`

- [ ] **Step 1: Add the helper to `file-doc.ts`**

In `src/lib/store/file-doc.ts`, after the existing `collectValidatedPairs` function (around line 148), add:

```ts
export interface RecentExampleCandidate {
  id: string
  original: string
  translated: string
  validationStatus: "full" | "self" | "none" | "empty" | "others"
  history: { timestamp: string; author: string; validated: boolean }[]
}

/**
 * Load candidate examples for Living Memory's Recent Examples section —
 * cells that have a non-empty translation and at least one history entry.
 * Filtering + sorting + limiting is performed by the pure selector
 * `selectRecentValidatedExamples`; this helper's only job is to stream
 * per-cell records across multiple file docs.
 *
 * Mirrors `collectValidatedPairs`' doc-load-and-destroy pattern.
 */
export async function collectRecentExampleCandidates(
  fileIds: string[],
): Promise<RecentExampleCandidate[]> {
  const out: RecentExampleCandidate[] = []

  for (const fileId of fileIds) {
    const handle = loadFileDoc(fileId)
    try {
      await new Promise<void>((resolve) => {
        if (handle.persistence.synced) resolve()
        else handle.persistence.once("synced", () => resolve())
      })

      const cellsMap = handle.doc.getMap("cells")
      const orderArray = handle.doc.getArray<string>("order")

      for (const cellId of orderArray.toArray()) {
        const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
        if (!cell) continue

        const translated = extractCellTranslated(cell)
        if (!translated.trim()) continue

        const historyArr = cell.get("history") as
          | Y.Array<{ timestamp?: string; author?: string; validated?: boolean }>
          | undefined
        const history = historyArr
          ? historyArr.toArray().map((h) => ({
              timestamp: h.timestamp ?? "",
              author: h.author ?? "",
              validated: !!h.validated,
            }))
          : []
        if (history.length === 0) continue
        const last = history[history.length - 1]
        if (!last.validated) continue

        // We don't have access to the per-user `__source.validatedBy` entries
        // here without extra plumbing; treat any cell whose last history
        // entry is `validated: true` as "full" for selector purposes.
        // Refine later if we need per-user granularity in Living Memory.
        out.push({
          id: cellId,
          original: (cell.get("original") as string) || "",
          translated,
          validationStatus: "full",
          history,
        })
      }
    } finally {
      destroyFileDoc(handle)
    }
  }

  return out
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -b --noEmit`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/store/file-doc.ts
git commit -m "feat(store): add collectRecentExampleCandidates for Living Memory"
```

---

### Task 10: Living Memory sections + page

**Files:**
- Create: `src/components/living-memory/InstructionsSection.tsx`
- Create: `src/components/living-memory/StandardsSection.tsx`
- Create: `src/components/living-memory/RecentExamplesSection.tsx`
- Create: `src/components/LivingMemoryPage.tsx`

- [ ] **Step 1: Create InstructionsSection**

Create `src/components/living-memory/InstructionsSection.tsx`:

```tsx
import { Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"

interface Props {
  projectId: string
  systemPrompt: string | undefined
  sourceLanguage: string
  targetLanguage: string
}

function resolvePrompt(template: string, src: string, tgt: string): string {
  return template
    .replace(/\{sourceLanguage\}/g, src)
    .replace(/\{targetLanguage\}/g, tgt)
}

export function InstructionsSection({
  projectId, systemPrompt, sourceLanguage, targetLanguage,
}: Props) {
  const resolved = resolvePrompt(systemPrompt ?? DEFAULT_SYSTEM_PROMPT, sourceLanguage, targetLanguage)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Instructions</CardTitle>
        <p className="text-sm text-muted-foreground">
          What Codex has been told about your project.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm font-sans">
          {resolved}
        </pre>
        <Link
          to={`/project/${projectId}/settings`}
          className="text-sm text-primary hover:underline"
        >
          Edit in Project Settings →
        </Link>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Create StandardsSection**

Create `src/components/living-memory/StandardsSection.tsx`:

```tsx
import { Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { groupRulesByType } from "./group-rules"
import type { TranslationRule } from "@/lib/parsers/types"

interface Props {
  projectId: string
  rules: TranslationRule[]
}

function RuleList({ title, rules }: { title: string; rules: TranslationRule[] }) {
  if (rules.length === 0) return null
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">{title} ({rules.length})</h4>
      <ul className="space-y-1">
        {rules.map((r) => (
          <li key={r.id} className="text-sm text-muted-foreground">
            • {r.name}
            <span className="ml-2 rounded bg-muted px-1.5 text-xs">
              {r.severity}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function StandardsSection({ projectId, rules }: Props) {
  const groups = groupRulesByType(rules)
  const empty =
    groups.mustPreserve.length === 0 &&
    groups.mustInclude.length === 0 &&
    groups.mustNotContain.length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Standards</CardTitle>
        <p className="text-sm text-muted-foreground">
          Rules this project has accumulated. Codex follows these and checks
          translations against them.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {empty ? (
          <p className="text-sm text-muted-foreground">
            No standards yet. Create rules to teach Codex what to preserve,
            require, or avoid.
          </p>
        ) : (
          <div className="space-y-3">
            <RuleList title="Must preserve" rules={groups.mustPreserve} />
            <RuleList title="Target must include when source matches" rules={groups.mustInclude} />
            <RuleList title="Must not contain" rules={groups.mustNotContain} />
          </div>
        )}
        <Link
          to={`/project/${projectId}/rules`}
          className="text-sm text-primary hover:underline"
        >
          Manage in Rules →
        </Link>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 3: Create RecentExamplesSection**

Create `src/components/living-memory/RecentExamplesSection.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { RecentExample } from "./recent-examples"

interface Props {
  examples: RecentExample[]
}

function formatTimestamp(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString()
}

export function RecentExamplesSection({ examples }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent examples</CardTitle>
        <p className="text-sm text-muted-foreground">
          The human-validated translations Codex is drawing from right now.
        </p>
      </CardHeader>
      <CardContent>
        {examples.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No validated translations yet. Validate a cell in the editor and
            it will appear here.
          </p>
        ) : (
          <ul className="space-y-4">
            {examples.map((ex) => (
              <li key={ex.cellId} className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {ex.author && `validated by ${ex.author}`}
                  {ex.author && ex.validatedAt && " · "}
                  {formatTimestamp(ex.validatedAt)}
                </div>
                <div className="text-sm">{ex.source}</div>
                <div className="text-sm text-muted-foreground">{ex.target}</div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: Create the page component**

Create `src/components/LivingMemoryPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { useRules } from "@/hooks/useRules"
import { useFeatureFlag } from "@/hooks/useFeatureFlag"
import { useLiveness } from "@/hooks/useLiveness"
import {
  collectRecentExampleCandidates,
  type RecentExampleCandidate,
} from "@/lib/store/file-doc"
import {
  selectRecentValidatedExamples,
  type RecentExample,
} from "@/components/living-memory/recent-examples"
import { LivenessIndicator } from "@/components/living-memory/LivenessIndicator"
import { InstructionsSection } from "@/components/living-memory/InstructionsSection"
import { StandardsSection } from "@/components/living-memory/StandardsSection"
import { RecentExamplesSection } from "@/components/living-memory/RecentExamplesSection"

const RECENT_EXAMPLES_LIMIT = 10

export function LivingMemoryPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { project, loading, refresh } = useProject(id!)
  // useRules takes (project, refresh) and returns an object whose `rules`
  // field is the current array. See src/hooks/useRules.ts.
  const { rules } = useRules(project, refresh)
  const enabled = useFeatureFlag("living-memory-view", project)

  // Bump counter advances whenever upstream state identity changes —
  // drives the "updating" flash on the liveness indicator.
  const [bumpedAt, setBumpedAt] = useState(0)
  useEffect(() => {
    setBumpedAt((n) => n + 1)
  }, [project, rules])

  const { state, label } = useLiveness(bumpedAt)

  // Aggregate validated examples across every file in the project. One-shot
  // load on mount + whenever the project's file list changes; not reactive
  // to per-cell edits (acceptable for v1 — the liveness flash still signals
  // that something changed, even if the list needs a refresh to catch up).
  const [candidates, setCandidates] = useState<RecentExampleCandidate[]>([])
  useEffect(() => {
    if (!project) return
    let cancelled = false
    const fileIds = project.files.map((f) => f.id)
    collectRecentExampleCandidates(fileIds).then((result) => {
      if (!cancelled) setCandidates(result)
    })
    return () => {
      cancelled = true
    }
  }, [project])

  const examples: RecentExample[] = useMemo(
    () => selectRecentValidatedExamples(candidates, RECENT_EXAMPLES_LIMIT),
    [candidates],
  )

  // Flag-off redirect — after project has loaded, not during.
  useEffect(() => {
    if (!loading && !enabled && project) {
      navigate(`/project/${id}`, {
        replace: true,
        state: {
          toast:
            "Living Memory is an experimental feature. Enable it in Project Settings.",
        },
      })
    }
  }, [loading, enabled, project, id, navigate])

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>
  }
  if (!project || !enabled) {
    return null
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Living Memory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This is what Codex has learned about your project. It grows with
            every edit, correction, and validation you make.
          </p>
        </div>
        <LivenessIndicator state={state} label={label} />
      </header>

      <InstructionsSection
        projectId={project.id}
        systemPrompt={project.completionSettings?.systemPrompt}
        sourceLanguage={project.sourceLanguage}
        targetLanguage={project.targetLanguage}
      />
      <StandardsSection projectId={project.id} rules={rules} />
      <RecentExamplesSection examples={examples} />
    </div>
  )
}
```

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc -b --noEmit && npm run lint`
Expected: exit code 0.

If type errors reference `useRules` / `useCells` shape, fix the call site at step 4's `LivingMemoryPage.tsx` to match the actual hook APIs.

- [ ] **Step 6: Commit**

```bash
git add src/components/living-memory/InstructionsSection.tsx \
        src/components/living-memory/StandardsSection.tsx \
        src/components/living-memory/RecentExamplesSection.tsx \
        src/components/LivingMemoryPage.tsx
git commit -m "feat(living-memory): page and sections for Living Memory view"
```

---

### Task 11: Register route + sidebar nav link

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ProjectWorkspace.tsx:423-435` (the `projectNavItems` memo)

- [ ] **Step 1: Register the route**

In `src/App.tsx`, add the import and route. After the `RulesPage` import:

```ts
import { LivingMemoryPage } from "@/components/LivingMemoryPage"
```

Inside `<Routes>`, add after the rules route:

```tsx
<Route path="/project/:id/memory" element={<LivingMemoryPage />} />
```

- [ ] **Step 2: Add the sidebar link gated by the flag**

In `src/components/ProjectWorkspace.tsx`:

Add import near the other component imports:

```ts
import { useFeatureFlag } from "@/hooks/useFeatureFlag"
import { Brain } from "lucide-react"
```

(If `Brain` collides with an existing import, substitute `Sparkles` or `BookOpen` — check the other nav icons in the memo for conflicts.)

Inside the component, near the other hook calls (before the `projectNavItems` memo at line 423):

```ts
const livingMemoryEnabled = useFeatureFlag("living-memory-view", project)
```

Modify the `projectNavItems` memo to conditionally include the Living Memory entry. Replace the existing memo body with:

```ts
const projectNavItems = useMemo(() => {
  const items = [
    { id: "rules", label: "Rules", icon: Scale,
      onClick: () => navigate(`/project/${projectId}/rules`) },
    { id: "comments", label: "Comments", icon: MessagesSquare,
      badge: Array.from(openCommentCount.values()).reduce((a, b) => a + b, 0),
      onClick: () => navigate(`/project/${projectId}/comments`) },
    { id: "snapshots", label: "Snapshots", icon: Camera,
      onClick: () => navigate(`/project/${projectId}/snapshots`) },
    { id: "share", label: "Share", icon: Share2,
      onClick: () => setShareOpen(true) },
    { id: "settings", label: "Settings", icon: SettingsIcon,
      onClick: () => navigate(`/project/${projectId}/settings`) },
  ]
  if (livingMemoryEnabled) {
    // Insert before Share so it sits with Rules/Comments/Snapshots.
    const insertIdx = items.findIndex((i) => i.id === "share")
    items.splice(insertIdx, 0, {
      id: "living-memory",
      label: "Living Memory",
      icon: Brain,
      onClick: () => navigate(`/project/${projectId}/memory`),
    })
  }
  return items
}, [projectId, navigate, openCommentCount, livingMemoryEnabled])
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc -b --noEmit && npm run lint`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(living-memory): wire route and flag-gated sidebar entry"
```

---

### Task 12: End-to-end smoke test

Full flow verification. No code changes — manual confirmation that all pieces work together.

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: all tests PASS. No regressions in existing suites.

- [ ] **Step 2: Start dev server**

Run: `npm run dev`

- [ ] **Step 3: Verify flag default is off**

1. Open any project.
2. Confirm there is no "Living Memory" link in the sidebar Project section.
3. Navigate directly to `/project/<id>/memory` in the URL bar.
4. Confirm the app redirects to `/project/<id>` without error.

- [ ] **Step 4: Enable the flag**

1. Go to Project Settings → Experimental section.
2. Toggle "Living Memory" on.
3. Confirm the Save button does **not** change to "unsaved changes" variant.
4. Navigate away (click a file in the sidebar). Confirm no dialog appears.

- [ ] **Step 5: Verify Living Memory entry appears**

1. The sidebar Project section now includes "Living Memory" between Snapshots and Share (or similar placement).
2. Click it. The Living Memory page loads.
3. Confirm three sections render: Instructions, Standards, Recent examples.
4. Confirm the liveness pill in the header shows green + a "Live" label.

- [ ] **Step 6: Verify liveness flashes on update**

1. In a second tab, open the same project and edit a cell (add text, validate, etc.).
2. In the Living Memory tab, the pill briefly shows yellow + "Updating…" then returns to green.

- [ ] **Step 7: Verify dirty warning still works for non-flag fields**

1. In Project Settings, edit the project name (don't save).
2. Confirm Save button shows "Save (unsaved changes)".
3. Click the Files nav link → "Unsaved changes" dialog appears with "Experimental toggles are saved automatically." text.
4. Click Stay → dialog closes.
5. Click Save → button returns to "Save"; no dialog on subsequent navigation.

- [ ] **Step 8: Disable the flag**

1. Toggle "Living Memory" off in Experimental.
2. Confirm the sidebar entry disappears.
3. Confirm direct URL access redirects again.

- [ ] **Step 9: Stop the dev server**

All manual checks passed. No code changes committed in this task.

---

## Self-review notes

- **Spec coverage:** every numbered goal and non-goal in the spec is addressed by one or more tasks (flag data model → Task 1; registry → Task 2; hook/setter → Task 3; Switch → Task 4; Experimental section with immediate persist → Task 5; dirty-field warning → Task 6; Living Memory helpers → Task 7; liveness → Task 8; cross-file example aggregator → Task 9; view + sections + page → Task 10; route + flag gating → Task 11; smoke test → Task 12).
- **Placeholders:** none. The one original deferred item (hook signatures for `useRules` / `useCells`) was resolved by adding Task 9's `collectRecentExampleCandidates` store helper and updating Task 10's page code to call the real `useRules(project, refresh)` shape. The `indexing` liveness state is implemented in the component + derivation but no code path sets it — matches the spec's "reserved for future agent work" framing.
- **Type/name consistency:** `FlagKey`, `getFlagValue`, `useFeatureFlag`, `setFeatureFlag`, `listFlags`, `flagDefault`, `deriveLivenessState`, `formatSyncedAgo`, `useLiveness`, `LivenessState`, `groupRulesByType`, `selectRecentValidatedExamples`, `RecentExample`, `RecentExampleCandidate`, `collectRecentExampleCandidates`, `StandardGroup`, `isSettingsDirty`, `SettingsFormSnapshot` — all introduced with exactly one signature and consistent through subsequent tasks.
- **Commit cadence:** 11 commits across 12 tasks (smoke-test task has no commit). Each commit is scoped to one conceptual change with prefixes matching recent repo style: `feat(flags)`, `feat(settings)`, `feat(living-memory)`, `feat(store)`, `chore(ui)`.
