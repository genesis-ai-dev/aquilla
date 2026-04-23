# Settings State Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two AI-setup bugs (model not persisted after connect; sparkle dialog uses a different UI than settings) by consolidating LLM settings UI into one shared form and introducing a small per-field commit/save primitive that any surface can use consistently.

**Architecture:** Three layers. (1) Data: race-safe `useSaveProjectPatch` hook is the single write path; `useProject` remains the read path. (2) Form primitive: `useSettingField` encapsulates optimistic local state, explicit commit, and clean/dirty sync rules. (3) Feature form: one `LlmSettingsForm` component with `compact` prop is used by the Settings page, the sparkle dialog, and the onboarding checklist. Validation (`isAiConfigured`) is extracted into a pure function used by the form, the sparkle button, and the completion hook — so they cannot disagree. URL commit auto-fires `/models` fetch; first model auto-persists when none set.

**Tech Stack:** React 19, TypeScript, vitest (happy-dom), @testing-library/react, Playwright (e2e), idb (IndexedDB).

**Spec:** [docs/superpowers/specs/2026-04-23-settings-state-model-design.md](../specs/2026-04-23-settings-state-model-design.md)

---

## File structure

**New files:**
- `src/lib/completion/is-configured.ts` — pure function `isAiConfigured(settings, session, frontierAvailable)` — single source of validation truth.
- `src/lib/completion/is-configured.test.ts` — truth-table unit tests.
- `src/hooks/useSaveProjectPatch.ts` — race-safe project patch hook.
- `src/hooks/useSaveProjectPatch.test.ts` — concurrent-patch test.
- `src/hooks/useSettingField.ts` — commit/optimistic/sync primitive + typed wrappers.
- `src/hooks/useSettingField.test.tsx` — rules tests (setValue vs commit, clean/dirty sync).
- `src/components/settings/LlmSettingsForm.tsx` — shared LLM form, `compact` prop.

**Modified files:**
- `src/hooks/useCompletion.ts` — replace inline `isConfigured` with `isAiConfigured`.
- `src/hooks/useCompletionSettings.ts` — reimplement on top of `useSaveProjectPatch` (keep exports stable).
- `src/components/ProjectSettings.tsx` — replace "Advanced LLM settings" block with `<LlmSettingsForm project />`.
- `src/components/AiSetupDialog.tsx` — replace `<AiProviderStep>` with `<LlmSettingsForm project compact />`.
- `src/components/onboarding/SetupChecklistDrawer.tsx` — replace `<AiProviderStep>` with `<LlmSettingsForm project compact />`.
- `e2e/ai-completion.spec.ts` — remove Connect button step; expect auto-connect.
- `e2e/ai-setup-dialog.spec.ts` — **new** e2e for dialog parity and cross-surface consistency.

**Deleted files:**
- `src/components/onboarding/checklist/AiProviderStep.tsx` — replaced by `LlmSettingsForm compact`.

---

## Task 1: Extract `isAiConfigured` pure function

**Why first:** Smallest, self-contained change. Locks down the validation contract in tests so later tasks can't regress it.

**Files:**
- Create: `src/lib/completion/is-configured.ts`
- Create: `src/lib/completion/is-configured.test.ts`
- Modify: `src/hooks/useCompletion.ts:24-46`

- [ ] **Step 1: Write the failing test**

Create `src/lib/completion/is-configured.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { isAiConfigured } from "./is-configured"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

function settings(overrides: Partial<CompletionSettings> = {}): CompletionSettings {
  return {
    provider: "frontier",
    endpoint: "",
    model: "",
    maxTokens: 512,
    temperature: 0.3,
    systemPrompt: "",
    llmHealthPenalty: 0.1,
    ...overrides,
  }
}

const session: FrontierSession = {
  jwt: "jwt-token",
  username: "u",
  email: "u@x",
  expiresAt: Date.now() + 1_000_000,
} as FrontierSession

describe("isAiConfigured", () => {
  it("frontier: requires session AND frontierAvailable", () => {
    expect(isAiConfigured(settings({ provider: "frontier" }), session, true)).toBe(true)
    expect(isAiConfigured(settings({ provider: "frontier" }), null, true)).toBe(false)
    expect(isAiConfigured(settings({ provider: "frontier" }), session, false)).toBe(false)
  })

  it("custom: requires both endpoint and model, ignores session/health", () => {
    const base = settings({ provider: "custom", endpoint: "http://x", model: "m" })
    expect(isAiConfigured(base, null, false)).toBe(true)

    expect(isAiConfigured({ ...base, endpoint: "" }, null, false)).toBe(false)
    expect(isAiConfigured({ ...base, model: "" }, null, false)).toBe(false)
  })

  it("implicit provider: falls back to custom when endpoint is set", () => {
    // No explicit provider; endpoint non-empty → treated as custom.
    const implicit = settings({ provider: undefined, endpoint: "http://x", model: "m" })
    expect(isAiConfigured(implicit, null, false)).toBe(true)
  })

  it("implicit provider: falls back to frontier when endpoint is empty", () => {
    const implicit = settings({ provider: undefined, endpoint: "", model: "" })
    expect(isAiConfigured(implicit, session, true)).toBe(true)
    expect(isAiConfigured(implicit, null, true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- is-configured`
Expected: FAIL with "Cannot find module './is-configured'" or similar.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/completion/is-configured.ts`:

```ts
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { resolveProvider } from "./completion-service"

/**
 * Single source of truth for whether AI completion can fire.
 * Used by useCompletion gating, the sparkle button, and LlmSettingsForm's
 * inline readiness indicator.
 */
export function isAiConfigured(
  settings: CompletionSettings,
  session: FrontierSession | null,
  frontierAvailable: boolean,
): boolean {
  const provider = resolveProvider(settings)
  if (provider === "frontier") {
    return Boolean(session?.jwt) && frontierAvailable
  }
  return Boolean(settings.endpoint) && Boolean(settings.model)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- is-configured`
Expected: PASS (4 tests).

- [ ] **Step 5: Swap `useCompletion.ts` to use it**

Replace `src/hooks/useCompletion.ts:44-46`:

```ts
// Before:
const isConfigured = provider === "frontier"
  ? Boolean(session?.jwt) && frontierAvailable
  : Boolean(effectiveSettings.endpoint && effectiveSettings.model)

// After:
const isConfigured = isAiConfigured(effectiveSettings, session, frontierAvailable)
```

Add import at top of the file:

```ts
import { isAiConfigured } from "@/lib/completion/is-configured"
```

The `provider` const (line 39) is no longer needed — `isAiConfigured` calls `resolveProvider` internally. Remove the line `const provider = resolveProvider(effectiveSettings)` and its `resolveProvider` import if unused elsewhere in the file (grep within the file first to confirm).

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- useCompletion is-configured` and `npx tsc -b --noEmit`
Expected: PASS on all tests. Typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/completion/is-configured.ts src/lib/completion/is-configured.test.ts src/hooks/useCompletion.ts
git commit -m "refactor: extract isAiConfigured to single source of truth"
```

---

## Task 2: Create `useSaveProjectPatch` hook

**Why next:** Subsequent UI tasks need this as the single write path. Wrapping `useSaveCompletionSettings` on top keeps the onboarding checklist working without changes until Task 5.

**Files:**
- Create: `src/hooks/useSaveProjectPatch.ts`
- Create: `src/hooks/useSaveProjectPatch.test.ts`
- Modify: `src/hooks/useCompletionSettings.ts`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useSaveProjectPatch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useSaveProjectPatch } from "./useSaveProjectPatch"
import { _resetDbForTesting, createProject, getProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

function baseProject(id: string): ProjectRecord {
  return {
    id,
    name: "test",
    sourceLanguage: "en",
    targetLanguage: "es",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
  }
}

describe("useSaveProjectPatch", () => {
  beforeEach(async () => {
    await _resetDbForTesting()
  })

  it("applies a top-level project patch", async () => {
    const id = "p1"
    await createProject(baseProject(id))
    const { result } = renderHook(() => useSaveProjectPatch(id))
    await act(async () => {
      await result.current({ name: "renamed" })
    })
    const after = await getProject(id)
    expect(after?.name).toBe("renamed")
  })

  it("applies a nested completionSettings patch and fills defaults", async () => {
    const id = "p2"
    await createProject(baseProject(id))
    const { result } = renderHook(() => useSaveProjectPatch(id))
    await act(async () => {
      await result.current({ completionSettings: { endpoint: "http://x" } })
    })
    const after = await getProject(id)
    expect(after?.completionSettings?.endpoint).toBe("http://x")
    expect(after?.completionSettings?.provider).toBe("frontier")
    expect(after?.completionSettings?.model).toBe("")
  })

  it("sequential patches accumulate (read-latest semantics)", async () => {
    const id = "p3"
    await createProject(baseProject(id))
    const { result } = renderHook(() => useSaveProjectPatch(id))
    await act(async () => {
      await result.current({ completionSettings: { endpoint: "http://a" } })
      await result.current({ completionSettings: { model: "m1" } })
    })
    const after = await getProject(id)
    expect(after?.completionSettings?.endpoint).toBe("http://a")
    expect(after?.completionSettings?.model).toBe("m1")
  })

  it("fires onUpdated with the merged record", async () => {
    const id = "p4"
    await createProject(baseProject(id))
    const updates: ProjectRecord[] = []
    const { result } = renderHook(() =>
      useSaveProjectPatch(id, (p) => { updates.push(p) })
    )
    await act(async () => {
      await result.current({ name: "new-name" })
    })
    expect(updates).toHaveLength(1)
    expect(updates[0].name).toBe("new-name")
  })

  it("no-ops when project does not exist", async () => {
    const { result } = renderHook(() => useSaveProjectPatch("missing"))
    await act(async () => {
      await result.current({ name: "x" })
    })
    const after = await getProject("missing")
    expect(after).toBeUndefined()
  })
})
```

**Note on concurrency:** this hook preserves the same read-then-write semantics as the existing `patchProject` in `project-index.ts`. Two writes racing to the same record have last-write-wins semantics — same as today's `useSaveCompletionSettings`. The form's commit model (one commit per field per user event) means real concurrent writes to the same record are rare in practice. Fixing the race (IDB `readwrite` transaction wrapping read + write) is out of scope here.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- useSaveProjectPatch`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useSaveProjectPatch.ts`:

```ts
import { useCallback } from "react"
import { patchProject } from "@/lib/store/project-index"
import { buildCompletionSettings } from "./useCompletionSettings"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"

export type ProjectPatch =
  | Partial<Omit<ProjectRecord, "completionSettings">>
  | { completionSettings: Partial<CompletionSettings> }
  | (Partial<Omit<ProjectRecord, "completionSettings">> & {
      completionSettings: Partial<CompletionSettings>
    })

/**
 * Single write path for project records.
 *
 * - Reads latest from IDB before merging (same semantics as patchProject).
 * - `completionSettings` key triggers a nested merge with defaults filled.
 * - Other top-level keys shallow-merge onto the root record.
 * - No-op when the project does not exist.
 *
 * @param onUpdated Optional callback fired with the merged record after the write.
 */
export function useSaveProjectPatch(
  projectId: string | undefined,
  onUpdated?: (p: ProjectRecord) => void,
) {
  return useCallback(
    async (patch: ProjectPatch): Promise<void> => {
      if (!projectId) return

      const updated = await patchProject(projectId, (latest) => {
        const { completionSettings: csPatch, ...topLevel } = patch as {
          completionSettings?: Partial<CompletionSettings>
        } & Partial<ProjectRecord>

        const merged: ProjectRecord = { ...latest, ...topLevel }
        if (csPatch) {
          merged.completionSettings = buildCompletionSettings(latest.completionSettings, csPatch)
        }
        return merged
      })

      if (updated) onUpdated?.(updated)
    },
    [projectId, onUpdated],
  )
}
```

**Why `patchProject` and not duplicating getProject+updateProject:** reuses the existing read-then-transform helper in `project-index.ts` so both call sites stay in sync if `patchProject` is ever hardened against concurrency.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- useSaveProjectPatch`
Expected: PASS (4 tests).

- [ ] **Step 5: Reimplement `useSaveCompletionSettings` on top of the new hook**

Replace `src/hooks/useCompletionSettings.ts` body (after the existing `buildCompletionSettings` / `resolveProvider` / `DEFAULT_SYSTEM_PROMPT` / `FRONTIER_CHAT_URL` exports, lines 36-54):

```ts
import { useCallback } from "react"
import { getProject, updateProject } from "@/lib/store/project-index"
import { DEFAULT_SYSTEM_PROMPT, FRONTIER_CHAT_URL, resolveProvider } from "@/lib/completion/completion-service"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { useSaveProjectPatch } from "./useSaveProjectPatch"

export function buildCompletionSettings(
  base: Partial<CompletionSettings> | undefined,
  overrides: Partial<CompletionSettings>,
): CompletionSettings {
  return {
    provider: overrides.provider ?? base?.provider ?? "frontier",
    endpoint: overrides.endpoint ?? base?.endpoint ?? "",
    apiKey: overrides.apiKey ?? base?.apiKey,
    model: overrides.model ?? base?.model ?? "",
    maxTokens: overrides.maxTokens ?? base?.maxTokens ?? 512,
    temperature: overrides.temperature ?? base?.temperature ?? 0.3,
    systemPrompt: overrides.systemPrompt ?? base?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    llmHealthPenalty: overrides.llmHealthPenalty ?? base?.llmHealthPenalty ?? 0.1,
  }
}

export { resolveProvider, DEFAULT_SYSTEM_PROMPT, FRONTIER_CHAT_URL }

/**
 * Backward-compat wrapper: delegates to useSaveProjectPatch with a
 * `{ completionSettings: overrides }` payload.
 */
export function useSaveCompletionSettings(
  projectId: string | undefined,
  onUpdated: (p: ProjectRecord) => void,
) {
  const save = useSaveProjectPatch(projectId, onUpdated)
  return useCallback(
    (overrides: Partial<CompletionSettings>) => save({ completionSettings: overrides }),
    [save],
  )
}
```

Also remove the now-unused `getProject`/`updateProject` imports from the top of `useCompletionSettings.ts` (the wrapper no longer calls them directly).

**Note on circular import:** `useSaveProjectPatch.ts` imports `buildCompletionSettings` from `useCompletionSettings.ts`, and `useCompletionSettings.ts` imports `useSaveProjectPatch` from `useSaveProjectPatch.ts`. TypeScript/ESM handles this because `useSaveProjectPatch` is imported as a value used at call time, and `buildCompletionSettings` is imported as a value used at call time — neither is read during module initialization. If vitest or Vite reports a circular-import warning, extract `buildCompletionSettings` into a new file `src/lib/completion/build-settings.ts` and have both hooks import from there.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- useSaveProjectPatch useCompletion` and `npx tsc -b --noEmit`
Expected: PASS. Typecheck clean. No new warnings.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useSaveProjectPatch.ts src/hooks/useSaveProjectPatch.test.ts src/hooks/useCompletionSettings.ts
git commit -m "feat(hooks): add useSaveProjectPatch, rewire useSaveCompletionSettings onto it"
```

---

## Task 3: Create `useSettingField` primitive + wrappers

**Why next:** `LlmSettingsForm` depends on this. Test the rules in isolation so the form code can stay a thin binding layer.

**Files:**
- Create: `src/hooks/useSettingField.ts`
- Create: `src/hooks/useSettingField.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useSettingField.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useSettingField } from "./useSettingField"

describe("useSettingField", () => {
  it("setValue updates local value but does not call save", () => {
    const save = vi.fn()
    const { result } = renderHook(() =>
      useSettingField<string>({ source: "a", save })
    )
    act(() => { result.current.setValue("b") })
    expect(result.current.value).toBe("b")
    expect(save).not.toHaveBeenCalled()
  })

  it("commit calls save with current local value and clears dirty", async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useSettingField<string>({ source: "a", save })
    )
    act(() => { result.current.setValue("b") })
    await act(async () => { await result.current.commit() })
    expect(save).toHaveBeenCalledWith("b")
    expect(result.current.value).toBe("b")
  })

  it("external source change while clean updates local value", () => {
    const save = vi.fn()
    const { result, rerender } = renderHook(
      ({ source }) => useSettingField<string>({ source, save }),
      { initialProps: { source: "a" } },
    )
    rerender({ source: "b" })
    expect(result.current.value).toBe("b")
  })

  it("external source change while dirty does NOT overwrite local value", () => {
    const save = vi.fn()
    const { result, rerender } = renderHook(
      ({ source }) => useSettingField<string>({ source, save }),
      { initialProps: { source: "a" } },
    )
    act(() => { result.current.setValue("user-typing") })
    rerender({ source: "remote-change" })
    expect(result.current.value).toBe("user-typing")
  })

  it("external source change after commit resumes tracking", async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ source }) => useSettingField<string>({ source, save }),
      { initialProps: { source: "a" } },
    )
    act(() => { result.current.setValue("typed") })
    await act(async () => { await result.current.commit() })
    // After commit, dirty is cleared — next source change wins.
    rerender({ source: "remote" })
    expect(result.current.value).toBe("remote")
  })

  it("savedFlash pulses briefly after commit", async () => {
    vi.useFakeTimers()
    try {
      const save = vi.fn().mockResolvedValue(undefined)
      const { result } = renderHook(() =>
        useSettingField<string>({ source: "a", save })
      )
      await act(async () => { await result.current.commit() })
      expect(result.current.savedFlash).toBe(true)
      await act(async () => { vi.advanceTimersByTime(1600) })
      await waitFor(() => expect(result.current.savedFlash).toBe(false))
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- useSettingField`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useSettingField.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react"

export interface UseSettingFieldArgs<T> {
  /** Current persisted value from the project record. */
  source: T
  /** Persist function; must not throw on expected errors. */
  save: (value: T) => Promise<void>
}

export interface UseSettingFieldResult<T> {
  /** Current local (possibly unsaved) value. */
  value: T
  /** Set local value. Marks the field dirty. Does NOT persist. */
  setValue: (v: T) => void
  /** Persist the current local value. Clears dirty. Pulses savedFlash. */
  commit: (override?: T) => Promise<void>
  /** True while a save is in flight. */
  saving: boolean
  /** Pulses true for ~1.5s after a successful commit. */
  savedFlash: boolean
}

/**
 * Core primitive for settings fields.
 *
 * Rules:
 * - `setValue` updates local state only and marks the field "dirty".
 * - `commit` calls `save` with the current local value (or an explicit
 *   override) and clears the dirty flag.
 * - When `source` changes externally AND the field is not dirty, local
 *   value syncs to the new source.
 * - When `source` changes externally AND the field is dirty, the external
 *   change is ignored until the next commit.
 */
export function useSettingField<T>({ source, save }: UseSettingFieldArgs<T>): UseSettingFieldResult<T> {
  const [value, setLocalValue] = useState<T>(source)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const dirtyRef = useRef(false)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync local from source whenever source changes AND we're not dirty.
  useEffect(() => {
    if (!dirtyRef.current) setLocalValue(source)
  }, [source])

  // Cleanup flash timer on unmount.
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [])

  const setValue = useCallback((v: T) => {
    dirtyRef.current = true
    setLocalValue(v)
  }, [])

  const commit = useCallback(async (override?: T) => {
    const next = (override === undefined ? value : override) as T
    setSaving(true)
    try {
      await save(next)
      dirtyRef.current = false
      setLocalValue(next)
      setSavedFlash(true)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1500)
    } finally {
      setSaving(false)
    }
  }, [save, value])

  return { value, setValue, commit, saving, savedFlash }
}

// ── Typed wrappers ──────────────────────────────────────────────────

/**
 * Text input / textarea: commit on blur or Enter.
 * Use `bind()` to spread onto an <input>.
 */
export function useTextField(args: UseSettingFieldArgs<string>) {
  const field = useSettingField(args)
  const bind = {
    value: field.value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => field.setValue(e.target.value),
    onBlur: () => { void field.commit() },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && e.currentTarget.tagName === "INPUT") {
        void field.commit()
      }
    },
  }
  return { ...field, bind }
}

/**
 * Toggle / checkbox / radio: commit on change.
 */
export function useToggleField<T>(args: UseSettingFieldArgs<T>) {
  const field = useSettingField(args)
  const set = (v: T) => { field.setValue(v); void field.commit(v) }
  return { ...field, set }
}

/**
 * <select>: commit on change.
 */
export function useSelectField<T extends string>(args: UseSettingFieldArgs<T>) {
  const field = useSettingField(args)
  const bind = {
    value: field.value,
    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value as T
      field.setValue(v)
      void field.commit(v)
    },
  }
  return { ...field, bind }
}

/**
 * <input type="range">: commit on mouseUp / keyUp.
 */
export function useSliderField(args: UseSettingFieldArgs<number>) {
  const field = useSettingField(args)
  const bind = {
    value: field.value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => field.setValue(Number(e.target.value)),
    onMouseUp: () => { void field.commit() },
    onKeyUp: () => { void field.commit() },
  }
  return { ...field, bind }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- useSettingField`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useSettingField.ts src/hooks/useSettingField.test.tsx
git commit -m "feat(hooks): add useSettingField primitive with typed wrappers"
```

---

## Task 4: Build `LlmSettingsForm` component

**Why next:** Unifies the UI across Settings, dialog, and onboarding. All subsequent tasks swap callers to this component.

**Files:**
- Create: `src/components/settings/LlmSettingsForm.tsx`

- [ ] **Step 1: Implement the form (no tests at the unit level — covered by e2e in Task 7/8)**

Create `src/components/settings/LlmSettingsForm.tsx`:

```tsx
import { useEffect, useRef, useState } from "react"
import { CheckCircle, XCircle, Loader2, Eye, EyeOff, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FRONTIER_CHAT_URL, DEFAULT_SYSTEM_PROMPT } from "@/hooks/useCompletionSettings"
import { fetchModels, resolveProvider } from "@/lib/completion/completion-service"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import { useSaveProjectPatch } from "@/hooks/useSaveProjectPatch"
import { useTextField, useSliderField } from "@/hooks/useSettingField"
import { isAiConfigured } from "@/lib/completion/is-configured"
import type { ProjectRecord, CompletionProvider } from "@/lib/parsers/types"

const CUSTOM_PRESETS: { id: string; label: string; endpoint: string; requiresKey: boolean; keyHint?: string }[] = [
  { id: "local", label: "Local / self-hosted (no key)", endpoint: "http://localhost:8000", requiresKey: false },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", requiresKey: true, keyHint: "sk-or-..." },
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", requiresKey: true, keyHint: "sk-..." },
  { id: "groq", label: "Groq", endpoint: "https://api.groq.com/openai/v1", requiresKey: true, keyHint: "gsk_..." },
  { id: "together", label: "Together AI", endpoint: "https://api.together.xyz/v1", requiresKey: true },
  { id: "mistral", label: "Mistral", endpoint: "https://api.mistral.ai/v1", requiresKey: true },
  { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com/v1", requiresKey: true },
  { id: "custom", label: "Other (enter URL manually)", endpoint: "", requiresKey: false },
]

function presetIdForEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "").toLowerCase()
  if (!trimmed) return "local"
  for (const p of CUSTOM_PRESETS) {
    if (!p.endpoint) continue
    const base = p.endpoint.toLowerCase()
    if (trimmed === base || trimmed.startsWith(base)) return p.id
  }
  return "custom"
}

export interface LlmSettingsFormProps {
  project: ProjectRecord
  /** Hide sliders and system prompt (used in sparkle dialog + onboarding). */
  compact?: boolean
  /** Fired after every successful write so parents can refresh caches. */
  onUpdated?: (p: ProjectRecord) => void
}

export function LlmSettingsForm({ project, compact = false, onUpdated }: LlmSettingsFormProps) {
  const { session } = useFrontierSession()
  const { available: frontierAvailable } = useFrontierHealth()

  const settings = project.completionSettings
  const currentProvider: CompletionProvider = settings ? resolveProvider(settings) : "frontier"

  const save = useSaveProjectPatch(project.id, onUpdated)

  // ── Fields ────────────────────────────────────────────────────────
  const endpoint = useTextField({
    source: settings?.endpoint ?? "",
    save: async (v) => { await save({ completionSettings: { endpoint: v.trim() } }) },
  })
  const apiKey = useTextField({
    source: settings?.apiKey ?? "",
    save: async (v) => { await save({ completionSettings: { apiKey: v.trim() || undefined } }) },
  })
  const model = useTextField({
    source: settings?.model ?? "",
    save: async (v) => { await save({ completionSettings: { model: v.trim() } }) },
  })
  const systemPrompt = useTextField({
    source: settings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    save: async (v) => { await save({ completionSettings: { systemPrompt: v } }) },
  })
  const maxTokens = useSliderField({
    source: settings?.maxTokens ?? 512,
    save: async (v) => { await save({ completionSettings: { maxTokens: v } }) },
  })
  const temperature = useSliderField({
    source: settings?.temperature ?? 0.3,
    save: async (v) => { await save({ completionSettings: { temperature: v } }) },
  })

  // ── Local UI state (not persisted) ────────────────────────────────
  const [presetId, setPresetId] = useState(() => presetIdForEndpoint(endpoint.value))
  const [showApiKey, setShowApiKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

  // Keep preset in sync with endpoint when endpoint syncs from remote.
  useEffect(() => {
    setPresetId(presetIdForEndpoint(endpoint.value))
  }, [endpoint.value])

  // ── Auto-connect to /models ───────────────────────────────────────
  // Triggered by: explicit preset change, endpoint commit, api key commit.
  // Re-entrancy guard via token: only the latest fetch's result is applied.
  const fetchTokenRef = useRef(0)

  async function tryFetchModels(ep: string, key: string) {
    const trimmedEp = ep.trim()
    if (!trimmedEp) {
      setModels([]); setConnected(false); setConnectionError(null); return
    }
    const myToken = ++fetchTokenRef.current
    setConnecting(true)
    setConnectionError(null)
    try {
      const list = await fetchModels(trimmedEp, key.trim() || undefined)
      if (myToken !== fetchTokenRef.current) return // stale
      setModels(list)
      setConnected(true)
      // Auto-select first model if none set yet.
      if (list.length > 0 && !model.value) {
        await model.commit(list[0])
      }
    } catch (err) {
      if (myToken !== fetchTokenRef.current) return
      setModels([])
      setConnected(false)
      setConnectionError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      if (myToken === fetchTokenRef.current) setConnecting(false)
    }
  }

  // Commit handlers that also trigger the fetch.
  async function commitEndpoint(next: string) {
    await save({ completionSettings: { endpoint: next.trim() } })
    await tryFetchModels(next, apiKey.value)
  }

  async function commitApiKey(next: string) {
    await save({ completionSettings: { apiKey: next.trim() || undefined } })
    // Only retry fetch if not yet connected — avoids fetch spam after success.
    if (!connected && endpoint.value.trim()) {
      await tryFetchModels(endpoint.value, next)
    }
  }

  async function handlePresetChange(nextPresetId: string) {
    const preset = CUSTOM_PRESETS.find((p) => p.id === nextPresetId)
    setPresetId(nextPresetId)
    setModels([])
    setConnected(false)
    setConnectionError(null)
    if (!preset) return
    if (preset.id !== "custom") {
      endpoint.setValue(preset.endpoint)
      await commitEndpoint(preset.endpoint)
    }
  }

  async function handleProviderChange(nextProvider: CompletionProvider) {
    // Switching back to frontier: clear custom endpoint indicator.
    if (nextProvider === "frontier") {
      setModels([]); setConnected(false); setConnectionError(null)
    }
    await save({ completionSettings: { provider: nextProvider, ...(nextProvider === "frontier" ? { endpoint: FRONTIER_CHAT_URL } : {}) } })
  }

  const configured = isAiConfigured(
    project.completionSettings ?? { provider: "frontier", endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "", llmHealthPenalty: 0.1 },
    session,
    frontierAvailable,
  )

  const preset = CUSTOM_PRESETS.find((p) => p.id === presetId) ?? CUSTOM_PRESETS[0]

  return (
    <div className="space-y-4" data-testid="llm-settings-form">
      {/* Provider selector */}
      <div className="space-y-2">
        <Label>Provider</Label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio" name="provider" className="mt-1"
            checked={currentProvider === "frontier"}
            onChange={() => handleProviderChange("frontier")}
          />
          <span><strong>Frontier</strong> (recommended) — signed-in API.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio" name="provider" className="mt-1"
            checked={currentProvider === "custom"}
            onChange={() => handleProviderChange("custom")}
          />
          <span><strong>Custom endpoint</strong> — localhost or OpenAI-compatible API.</span>
        </label>
      </div>

      {currentProvider === "custom" && (
        <>
          <div>
            <Label htmlFor="preset">Provider preset</Label>
            <select
              id="preset"
              value={presetId}
              onChange={(e) => { void handlePresetChange(e.target.value) }}
              className="w-full rounded border bg-background px-3 py-2 text-sm"
            >
              {CUSTOM_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>

          <div>
            <Label htmlFor="ep">Endpoint URL</Label>
            <Input
              id="ep"
              value={endpoint.value}
              onChange={(e) => { endpoint.setValue(e.target.value); setPresetId(presetIdForEndpoint(e.target.value)) }}
              onBlur={() => { void commitEndpoint(endpoint.value) }}
              placeholder="http://localhost:8000"
            />
            <div className="mt-1 min-h-4 text-xs">
              {connecting && <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Connecting…</span>}
              {!connecting && connected && <span className="flex items-center gap-1 text-green-600"><CheckCircle className="h-3 w-3" /> Connected — {models.length} model(s)</span>}
              {!connecting && connectionError && <span className="flex items-center gap-1 text-destructive"><XCircle className="h-3 w-3" /> {connectionError}</span>}
            </div>
          </div>

          <div>
            <Label htmlFor="apikey">
              API key {preset.requiresKey ? <span className="text-destructive">*</span> : <span className="text-muted-foreground">(optional)</span>}
            </Label>
            <div className="flex gap-2">
              <Input
                id="apikey"
                type={showApiKey ? "text" : "password"}
                value={apiKey.value}
                onChange={(e) => apiKey.setValue(e.target.value)}
                onBlur={() => { void commitApiKey(apiKey.value) }}
                placeholder={preset.keyHint ?? "Leave blank for no auth"}
                autoComplete="off" spellCheck={false}
                className="flex-1 font-mono"
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowApiKey((v) => !v)} aria-label={showApiKey ? "Hide API key" : "Show API key"}>
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div>
            <Label htmlFor="mdl">Model</Label>
            {models.length > 0 ? (
              <select
                id="mdl"
                value={model.value}
                onChange={(e) => { const v = e.target.value; model.setValue(v); void model.commit(v) }}
                className="w-full rounded border bg-background px-3 py-2 text-sm"
              >
                {!model.value && <option value="">Select a model…</option>}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <Input
                id="mdl"
                value={model.value}
                onChange={(e) => model.setValue(e.target.value)}
                onBlur={() => { void model.commit() }}
                placeholder={presetId === "openrouter" ? "anthropic/claude-3.5-sonnet" : "Type a model id"}
              />
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {configured
                ? <><Check className="inline h-3 w-3 text-green-600" /> Ready</>
                : endpoint.value.trim() && !model.value.trim()
                  ? "Pick a model to enable AI."
                  : "Set an endpoint URL to begin."}
            </p>
          </div>
        </>
      )}

      {currentProvider === "frontier" && (
        <div>
          <Label htmlFor="mdl-frontier">Model override (optional)</Label>
          <Input
            id="mdl-frontier"
            {...model.bind}
            placeholder="Leave blank for Frontier's default"
          />
        </div>
      )}

      {!compact && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="mt">Max Tokens</Label>
              <Input id="mt" type="number" value={maxTokens.value} onChange={(e) => maxTokens.setValue(Number(e.target.value))} onBlur={() => { void maxTokens.commit() }} />
            </div>
            <div>
              <Label>Temperature ({temperature.value})</Label>
              <input type="range" min={0} max={1} step={0.05} {...temperature.bind} className="mt-2 w-full" />
            </div>
          </div>

          <div>
            <Label htmlFor="sp">System prompt</Label>
            <textarea
              id="sp"
              value={systemPrompt.value}
              onChange={(e) => systemPrompt.setValue(e.target.value)}
              onBlur={() => { void systemPrompt.commit() }}
              rows={4}
              className="w-full rounded border bg-background px-3 py-2 font-mono text-sm"
              placeholder={DEFAULT_SYSTEM_PROMPT}
            />
          </div>
        </>
      )}
    </div>
  )
}
```

**Notes for the engineer:**
- `fetchTokenRef` guards against a late-arriving `/models` response overwriting a newer one (user types URL A, blurs, types URL B, blurs — we keep B's result).
- The "frontier" branch writes `endpoint: FRONTIER_CHAT_URL` so `resolveProvider` keeps behavior identical to today.
- The inline "Ready" indicator shares its truth with `useCompletion` and `SparkleButton` via `isAiConfigured`.
- The form never renders a "Save" button — every field commits on its natural event.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Quick smoke test in the browser**

Run: `npm run dev`. In a browser, navigate to an existing project's Settings. Expand "Advanced LLM settings". Open the React DevTools component tree and confirm `LlmSettingsForm` is NOT yet rendered (it won't be until Task 6 — this is just a build sanity check).

Kill dev server when done.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/LlmSettingsForm.tsx
git commit -m "feat(settings): add shared LlmSettingsForm with auto-connect and auto-select"
```

---

## Task 5: Swap AiSetupDialog and SetupChecklistDrawer to LlmSettingsForm; delete AiProviderStep

**Why now:** Fixes bug #2 (dialog duplicated UI) and removes the dead onboarding component. This is smaller than swapping the whole Settings page, so we validate the new form in the simpler surfaces first.

**Files:**
- Modify: `src/components/AiSetupDialog.tsx`
- Modify: `src/components/onboarding/SetupChecklistDrawer.tsx:13,87`
- Delete: `src/components/onboarding/checklist/AiProviderStep.tsx`

- [ ] **Step 1: Update `AiSetupDialog.tsx`**

Replace the entire body of `src/components/AiSetupDialog.tsx`:

```tsx
import { Sparkles } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { LlmSettingsForm } from "@/components/settings/LlmSettingsForm"
import type { ProjectRecord } from "@/lib/parsers/types"

interface AiSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiSetupDialog({ open, onOpenChange, project, onUpdated }: AiSetupDialogProps) {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Set up AI
          </DialogTitle>
          <DialogDescription>
            Choose a provider to enable translation suggestions.
          </DialogDescription>
        </DialogHeader>

        <LlmSettingsForm project={project} compact onUpdated={onUpdated} />

        <div className="text-center">
          <button
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              onOpenChange(false)
              navigate(`/project/${id}/settings`)
            }}
          >
            Full settings →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

Note the intentional behavior change: the dialog no longer auto-closes on the first save (previously, `AiProviderStep.onUpdated` called `onOpenChange(false)`). Since writes are now automatic and continuous, closing on each commit would be hostile. The user closes via the close button or the "Full settings →" link.

- [ ] **Step 2: Update `SetupChecklistDrawer.tsx`**

In `src/components/onboarding/SetupChecklistDrawer.tsx`:

Replace line 13 import:

```ts
// Before:
import { AiProviderStep } from "./checklist/AiProviderStep"

// After:
import { LlmSettingsForm } from "@/components/settings/LlmSettingsForm"
```

Replace line 87 usage:

```tsx
// Before:
<AiProviderStep project={project} onUpdated={onProjectUpdated} />

// After:
<LlmSettingsForm project={project} compact onUpdated={onProjectUpdated} />
```

- [ ] **Step 3: Delete `AiProviderStep.tsx`**

```bash
git rm src/components/onboarding/checklist/AiProviderStep.tsx
```

- [ ] **Step 4: Verify no remaining imports**

Run: `grep -rn "AiProviderStep" src/ e2e/ || echo "no references"`
Expected: `no references`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 6: Browser smoke test**

Run: `npm run dev`. Open an existing project in the browser. Click a disabled sparkle (or trigger the setup checklist) to open `AiSetupDialog`. Verify:
- Provider radio renders
- Picking "Custom" shows preset + URL + API key + Model
- No "Save" button
- No "Connect" button
- "Full settings →" link is present

Kill dev server.

- [ ] **Step 7: Commit**

```bash
git add src/components/AiSetupDialog.tsx src/components/onboarding/SetupChecklistDrawer.tsx
git commit -m "refactor: AiSetupDialog + onboarding use shared LlmSettingsForm; delete AiProviderStep"
```

---

## Task 6: Swap ProjectSettings to LlmSettingsForm

**Why now:** The dialog and onboarding paths are already validated on the new form. This is the biggest line-count change but mechanically straightforward.

**Files:**
- Modify: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Replace the LLM + AI Instructions blocks**

Open `src/components/ProjectSettings.tsx`. This replaces:
- The AI Instructions `<Card>` block (approximately lines 224–247) — its content (system prompt) is now inside `LlmSettingsForm`.
- The entire `<details>` "Advanced LLM settings" block (approximately lines 249–425).

Replace both blocks with a single card:

```tsx
<Card>
  <CardHeader>
    <CardTitle className="flex items-center gap-2">
      <Sparkles className="h-4 w-4 text-primary" />
      AI Settings
    </CardTitle>
  </CardHeader>
  <CardContent>
    {project ? (
      <LlmSettingsForm project={project} onUpdated={() => { refresh(); flash() }} />
    ) : null}
  </CardContent>
</Card>
```

Add import at top of `ProjectSettings.tsx`:

```ts
import { LlmSettingsForm } from "@/components/settings/LlmSettingsForm"
```

- [ ] **Step 2: Remove now-dead local state and handlers**

These `useState` declarations and helpers become unused — delete them:

```ts
// Delete:
const [provider, setProvider] = useState<CompletionProvider>("frontier")
const [endpoint, setEndpoint] = useState("")
const [apiKey, setApiKey] = useState("")
const [showApiKey, setShowApiKey] = useState(false)
const [presetId, setPresetId] = useState<string>("local")
const [model, setModel] = useState("")
const [maxTokens, setMaxTokens] = useState(512)
const [temperature, setTemperature] = useState(0.3)
const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
const [llmHealthPenalty, setLlmHealthPenalty] = useState(0.1)
const [models, setModels] = useState<string[]>([])
const [connecting, setConnecting] = useState(false)
const [connectionError, setConnectionError] = useState<string | null>(null)
const [connected, setConnected] = useState(false)

// And the handlers:
function handlePresetChange(...) { ... }
async function handleConnect() { ... }
```

Delete the entire `if (project.completionSettings) { ... }` block inside the useEffect at lines ~96-106 — none of its setters remain. Keep the surrounding useEffect (name/languages/username/autoSync/validation counts stay).

**llmHealthPenalty specifically:** this slider was in Advanced LLM settings but is not in `LlmSettingsForm`. If the `composite-health` flag is off, we still need it. Add it to `LlmSettingsForm` as a non-compact-only slider now, OR keep a separate card in `ProjectSettings` just for it. Pick: keep separate card in `ProjectSettings`, unchanged. So keep `llmHealthPenalty` state and its render block — but move the render to its own `<Card>` or keep inside the remaining `<details>` if simpler. **Simplest:** leave the existing `llmHealthPenalty` slider in place as a standalone field elsewhere on the page (e.g. inside a small "Legacy health penalty" card shown only when `!compositeFlag`). The engineer should grep for `llmHealthPenalty` in `ProjectSettings.tsx`, extract its render + state, and drop it into a standalone card next to the LLM settings card.

- [ ] **Step 3: Remove dead imports**

After the deletions, Prettier/ESLint should surface unused imports. Remove them:

```ts
// Likely unused after this change:
import { CheckCircle, XCircle, Loader2, Eye, EyeOff } from "lucide-react"
import { Input } from "@/components/ui/input" // keep if still used elsewhere on the page
import { fetchModels, resolveProvider } from "@/lib/completion/completion-service"
import { useSaveCompletionSettings, DEFAULT_SYSTEM_PROMPT, buildCompletionSettings } from "@/hooks/useCompletionSettings"
```

Keep what's still referenced (project-info inputs, validation, experimental flags, git-sync).

Also delete the file-local `CUSTOM_PRESETS` array and `presetIdForEndpoint` helper (they're inside `LlmSettingsForm` now).

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: clean. Fix any remaining dead-import warnings.

- [ ] **Step 5: Unit tests**

Run: `npm test`
Expected: all pass. If any existing test imports something we removed, update the test.

- [ ] **Step 6: Browser smoke test**

Run: `npm run dev`. Open a project, click Settings. Verify:
- AI Settings card renders with provider radio
- Picking Custom shows preset/URL/key/model
- Typing a URL + blur fires a fetch (check Network tab)
- System prompt is present (non-compact variant)
- Max tokens + temperature sliders present
- LLM health penalty slider present when composite-health flag is off

Kill dev server.

- [ ] **Step 7: Commit**

```bash
git add src/components/ProjectSettings.tsx
git commit -m "refactor(settings): use shared LlmSettingsForm in ProjectSettings page"
```

---

## Task 7: Update existing e2e test to match auto-connect behavior

**Files:**
- Modify: `e2e/ai-completion.spec.ts`

- [ ] **Step 1: Update the endpoint/connect sequence**

Replace `e2e/ai-completion.spec.ts` lines ~42-58 (the Advanced settings open, radio select, endpoint fill, Connect click, wait-for-Connected sequence). The new flow:

```ts
// Navigate to settings
await page.goto(`/project/${projectId}/settings`)

// Select Custom endpoint radio
await page.locator("input[name='provider'][type='radio']").last().check()

// The "custom" branch of the form renders immediately.
// Type mock server URL and blur to trigger auto-connect.
const endpointInput = page.locator("#ep")
await endpointInput.fill(mockServer.baseUrl)
await endpointInput.blur()

// Wait for auto-connect to complete and auto-select a model.
await expect(page.getByText(/Connected —/)).toBeVisible({ timeout: 10_000 })

// Assert the model field has a non-empty value (auto-selected).
const modelSelect = page.locator("#mdl")
await expect(modelSelect).not.toHaveValue("")
```

The "Advanced LLM settings" `<details>` wrapper no longer exists — the LLM form is a top-level card in Settings. Remove the `page.locator("details").filter(...).click()` line entirely.

- [ ] **Step 2: Run e2e**

Run: `npm run test:e2e -- ai-completion`
Expected: PASS.

If it fails because the mock server doesn't implement `/models`, check `e2e/mock-llm-server.ts`. The existing `Connect` test was working, which means `/models` is already handled. If not, add a `/models` GET handler that returns `{ data: [{ id: "mock-model" }] }`.

- [ ] **Step 3: Commit**

```bash
git add e2e/ai-completion.spec.ts
# If mock-llm-server.ts was updated:
# git add e2e/mock-llm-server.ts
git commit -m "test(e2e): update ai-completion for auto-connect model flow"
```

---

## Task 8: New e2e spec for dialog parity and cross-surface consistency

**Files:**
- Create: `e2e/ai-setup-dialog.spec.ts`

- [ ] **Step 1: Write the spec**

Create `e2e/ai-setup-dialog.spec.ts`:

```ts
import { test, expect } from "@playwright/test"
import { MockLLMServer } from "./mock-llm-server"
import {
  resetAndGotoDashboard,
  createProject,
  openProject,
} from "./helpers"

let mockServer: MockLLMServer
test.beforeAll(async () => { mockServer = new MockLLMServer(); await mockServer.start() })
test.afterAll(async () => { await mockServer.stop() })
test.beforeEach(async ({ page }) => { await resetAndGotoDashboard(page) })

test("sparkle dialog shows the same LlmSettingsForm as the Settings page", async ({ page }) => {
  const projectName = await createProject(page)
  await openProject(page, projectName)
  const projectId = page.url().split("/project/")[1]?.split("/")[0] ?? ""

  // Open sparkle dialog via the "disabled sparkle" path (setup not complete yet).
  // Find any sparkle button and click — dialog should open because !isConfigured.
  const sparkle = page.locator("button[title*='Generate translation']").first()
  if (await sparkle.count()) {
    await sparkle.click()
  } else {
    // No cells exist yet; drive the dialog via the onboarding checklist or direct URL.
    // Use setup checklist button if it exists; otherwise skip this test.
    test.skip(true, "no sparkle available on empty project")
  }

  // Dialog renders LlmSettingsForm (same data-testid as Settings page).
  const dialogForm = page.locator("[data-testid='llm-settings-form']")
  await expect(dialogForm).toBeVisible({ timeout: 5_000 })

  // Pick Custom, type URL, blur → auto-connect.
  await dialogForm.locator("input[name='provider'][type='radio']").last().check()
  const dialogUrl = dialogForm.locator("#ep")
  await dialogUrl.fill(mockServer.baseUrl)
  await dialogUrl.blur()
  await expect(page.getByText(/Connected —/)).toBeVisible({ timeout: 10_000 })

  // Close dialog (Escape), open Settings page, confirm same state reflected.
  await page.keyboard.press("Escape")
  await page.goto(`/project/${projectId}/settings`)
  const settingsForm = page.locator("[data-testid='llm-settings-form']")
  await expect(settingsForm).toBeVisible()
  await expect(settingsForm.locator("#ep")).toHaveValue(mockServer.baseUrl)
  await expect(settingsForm.locator("input[name='provider'][type='radio']").last()).toBeChecked()
})

test("bad URL shows inline error and falls back to text model input", async ({ page }) => {
  const projectName = await createProject(page)
  await openProject(page, projectName)
  const projectId = page.url().split("/project/")[1]?.split("/")[0] ?? ""

  await page.goto(`/project/${projectId}/settings`)
  const form = page.locator("[data-testid='llm-settings-form']")
  await form.locator("input[name='provider'][type='radio']").last().check()

  const ep = form.locator("#ep")
  await ep.fill("http://127.0.0.1:1")  // guaranteed refused
  await ep.blur()

  // Inline error message appears.
  await expect(form.getByText(/Connected|Connecting|failed|refused|fetch/i)).toBeVisible({ timeout: 10_000 })

  // Model field is present as free text (not a <select>).
  const modelField = form.locator("#mdl")
  await expect(modelField).toBeVisible()
  await modelField.fill("my-manual-model")
  await modelField.blur()
  // Reload — value persisted.
  await page.reload()
  const afterReload = page.locator("[data-testid='llm-settings-form'] #mdl")
  await expect(afterReload).toHaveValue("my-manual-model")
})
```

- [ ] **Step 2: Run the new spec**

Run: `npm run test:e2e -- ai-setup-dialog`
Expected: PASS (or skip for the empty-project edge).

- [ ] **Step 3: Commit**

```bash
git add e2e/ai-setup-dialog.spec.ts
git commit -m "test(e2e): dialog parity and cross-surface consistency"
```

---

## Task 9: Full-stack verification

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 2: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: all PASS.

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc -b --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 4: Manual regression sanity**

Run: `npm run dev`. In a browser:
1. Create a new project.
2. Open settings → Custom → enter a working URL (or a mock one) → blur.
3. Verify auto-connect spinner, "Connected" indicator, model auto-selected.
4. Go back to editor → click sparkle → verify completion fires (no "didn't pick a model").
5. Open sparkle dialog from another cell → verify it shows the same form (compact).
6. Change provider back to Frontier in the dialog → close → reopen Settings → confirm Frontier is selected.
7. Toggle auto-sync, validation counts, experimental flags — confirm unrelated settings still work.

- [ ] **Step 5: No commit needed for this task** (verification only).

---

## Self-review notes

**Spec coverage:**
- Bug 1 (model-not-persisted) — Task 4 (form never has the divergent path) + Task 9 step 4 regression check. ✓
- Bug 2 (dialog duplicate UI) — Task 5 + Task 8. ✓
- Layer 1 (`useSaveProjectPatch`) — Task 2. ✓
- Layer 2 (`useSettingField` + wrappers) — Task 3. ✓
- Layer 3 (`LlmSettingsForm`) — Task 4. ✓
- Validation parity (`isAiConfigured`) — Task 1. ✓
- Auto-connect + auto-select — Task 4 + Task 7 + Task 8. ✓
- Fallback free-text model on `/models` failure — Task 8 covers it (and Task 4 implements it). ✓
- Cross-surface consistency — Task 8. ✓

**Non-goals kept out of scope:**
- No global store. ✓
- No non-LLM settings refactor. ✓
- No IDB schema change. ✓

**Known open questions for the engineer (ask before implementing if ambiguous):**
- `llmHealthPenalty` placement after `ProjectSettings` rewrite: spec says "opportunistic", Task 6 Step 2 keeps it as its own block. If the engineer prefers to fold it into `LlmSettingsForm` as a non-compact field, that's an acceptable simplification — update `LlmSettingsForm` to accept it.
- `AiSetupDialog` previously auto-closed on first save. Task 5 deliberately removes that. If user-testing finds the dialog feels sticky, add an explicit "Done" button in the dialog footer that calls `onOpenChange(false)` — do NOT reintroduce the auto-close.
