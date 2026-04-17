# Onboarding Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give new users a warm, guided path from first visit to productive translation work — a 5-step app wizard plus a per-project setup checklist drawer.

**Architecture:** App-level onboarding is a multi-step wizard at `/onboarding` that creates the first project and redirects to the workspace. The per-project setup checklist is a right-side drawer that opens automatically on first entry and tracks AI provider, instructions, and collaborator setup. Completion state is derived from existing project settings — only one new field (`setupChecklistDismissed`) is added.

**Tech Stack:** React 19, react-router-dom 7, Tailwind 4, @base-ui/react, existing `FrontierLoginForm` + `SharePanel` + `useFrontierSession` components.

**Spec:** `docs/superpowers/specs/2026-04-16-onboarding-flow-design.md`

---

## File map

**New:**
- `src/components/onboarding/OnboardingWizard.tsx` — step state machine + layout
- `src/components/onboarding/steps/WelcomeStep.tsx`
- `src/components/onboarding/steps/SignInStep.tsx`
- `src/components/onboarding/steps/NameStep.tsx`
- `src/components/onboarding/steps/ProjectStep.tsx`
- `src/components/onboarding/steps/ReadyStep.tsx`
- `src/components/onboarding/SetupChecklistDrawer.tsx`
- `src/components/onboarding/checklist/AiProviderStep.tsx`
- `src/components/onboarding/checklist/AiInstructionsStep.tsx`
- `src/components/onboarding/checklist/InviteStep.tsx`
- `src/components/onboarding/checklist/ComingSoonStep.tsx`
- `src/hooks/useSetupChecklist.ts`
- `src/hooks/useSetupChecklist.test.ts`

**Modified:**
- `src/lib/parsers/types.ts` — add `setupChecklistDismissed?: boolean` to `ProjectRecord`
- `src/App.tsx` — add `/onboarding` route
- `src/components/Dashboard.tsx` — redirect when onboarding incomplete
- `src/components/ProjectWorkspace.tsx` — mount `SetupChecklistDrawer`, auto-open state
- `src/components/Toolbar.tsx` — setup progress pill, login button for anonymous
- `src/components/EditorTable.tsx` — sparkle tooltip for anonymous users
- `src/components/ProjectSettings.tsx` — "View setup checklist" button

---

## Task 1: Schema + global username + useSetupChecklist hook

**Files:**
- Modify: `src/lib/parsers/types.ts`
- Create: `src/hooks/useSetupChecklist.ts`
- Create: `src/hooks/useSetupChecklist.test.ts`

- [ ] **Step 1: Add `setupChecklistDismissed` to `ProjectRecord`**

In `src/lib/parsers/types.ts`, inside the `ProjectRecord` interface (after the `syncSettings?` field, around line 78), add:

```ts
  setupChecklistDismissed?: boolean
```

- [ ] **Step 2: Write the failing test for `useSetupChecklist`**

Create `src/hooks/useSetupChecklist.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { deriveChecklistState, type ChecklistState } from "./useSetupChecklist"

describe("deriveChecklistState", () => {
  it("returns all incomplete when project has no settings", () => {
    const state = deriveChecklistState({}, 0)
    expect(state.aiProvider).toBe(false)
    expect(state.aiInstructions).toBe(false)
    expect(state.collaborators).toBe(false)
    expect(state.completedCount).toBe(0)
    expect(state.totalCount).toBe(3)
  })

  it("marks aiProvider complete when endpoint is set", () => {
    const state = deriveChecklistState(
      { endpoint: "https://api.frontierrnd.com/api/v1/chat/completions", model: "m", maxTokens: 512, temperature: 0.3, systemPrompt: "", llmHealthPenalty: 0.1 },
      0
    )
    expect(state.aiProvider).toBe(true)
  })

  it("marks aiInstructions complete when systemPrompt is non-empty", () => {
    const state = deriveChecklistState(
      { endpoint: "", model: "", maxTokens: 512, temperature: 0.3, systemPrompt: "Translate carefully.", llmHealthPenalty: 0.1 },
      0
    )
    expect(state.aiInstructions).toBe(true)
  })

  it("marks collaborators complete when shareCount > 0", () => {
    const state = deriveChecklistState({}, 2)
    expect(state.collaborators).toBe(true)
  })

  it("counts completed items correctly", () => {
    const state = deriveChecklistState(
      { endpoint: "x", model: "m", maxTokens: 512, temperature: 0.3, systemPrompt: "y", llmHealthPenalty: 0.1 },
      1
    )
    expect(state.completedCount).toBe(3)
    expect(state.totalCount).toBe(3)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/hooks/useSetupChecklist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `useSetupChecklist`**

Create `src/hooks/useSetupChecklist.ts`:

```ts
import { useEffect, useState, useCallback } from "react"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { updateProject } from "@/lib/store/project-index"
import { listShares } from "@/lib/sync/share-tokens"

export interface ChecklistState {
  aiProvider: boolean
  aiInstructions: boolean
  collaborators: boolean
  completedCount: number
  totalCount: number
}

export function deriveChecklistState(
  settings: Partial<CompletionSettings> | undefined,
  shareCount: number
): ChecklistState {
  const aiProvider = Boolean(settings?.endpoint?.trim())
  const aiInstructions = Boolean(settings?.systemPrompt?.trim())
  const collaborators = shareCount > 0
  const items = [aiProvider, aiInstructions, collaborators]
  return {
    aiProvider,
    aiInstructions,
    collaborators,
    completedCount: items.filter(Boolean).length,
    totalCount: items.length,
  }
}

export function useSetupChecklist(project: ProjectRecord | null) {
  const [shareCount, setShareCount] = useState(0)
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    if (!project) return
    setDismissed(project.setupChecklistDismissed ?? false)
    listShares(project.id).then((shares) => setShareCount(shares.length))
  }, [project])

  const state = deriveChecklistState(project?.completionSettings, shareCount)

  const dismiss = useCallback(async () => {
    if (!project) return
    await updateProject({ ...project, setupChecklistDismissed: true })
    setDismissed(true)
  }, [project])

  const refreshShares = useCallback(async () => {
    if (!project) return
    const shares = await listShares(project.id)
    setShareCount(shares.length)
  }, [project])

  return { state, dismissed, dismiss, refreshShares }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/hooks/useSetupChecklist.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/parsers/types.ts src/hooks/useSetupChecklist.ts src/hooks/useSetupChecklist.test.ts
git commit -m "feat(onboarding): add setupChecklistDismissed field + useSetupChecklist hook"
```

---

## Task 2: OnboardingWizard shell + routing + Dashboard redirect

**Files:**
- Create: `src/components/onboarding/OnboardingWizard.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Dashboard.tsx`

- [ ] **Step 1: Create the wizard shell**

Create `src/components/onboarding/OnboardingWizard.tsx`:

```tsx
import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { v4 as uuid } from "uuid"
import { createProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"
import { WelcomeStep } from "./steps/WelcomeStep"
import { SignInStep } from "./steps/SignInStep"
import { NameStep } from "./steps/NameStep"
import { ProjectStep } from "./steps/ProjectStep"
import { ReadyStep } from "./steps/ReadyStep"

const TOTAL_STEPS = 5

export function OnboardingWizard() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [displayName, setDisplayName] = useState("")
  const [createdProject, setCreatedProject] = useState<ProjectRecord | null>(null)

  const next = useCallback(() => setStep((s) => Math.min(s + 1, TOTAL_STEPS)), [])
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 1)), [])

  const handleProjectCreated = useCallback((project: ProjectRecord) => {
    setCreatedProject(project)
    next()
  }, [next])

  const handleFinish = useCallback(() => {
    localStorage.setItem("codex:onboardingComplete", "true")
    if (createdProject) {
      navigate(`/project/${createdProject.id}`)
    } else {
      navigate("/")
    }
  }, [createdProject, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        {/* Step indicator */}
        <div className="mb-8 flex justify-center gap-2">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={
                "h-2 w-2 rounded-full transition-colors " +
                (i + 1 <= step ? "bg-primary" : "bg-muted")
              }
            />
          ))}
        </div>

        {/* Steps */}
        {step === 1 && <WelcomeStep onNext={next} />}
        {step === 2 && <SignInStep onNext={next} onBack={back} />}
        {step === 3 && (
          <NameStep
            value={displayName}
            onChange={setDisplayName}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 4 && (
          <ProjectStep
            displayName={displayName}
            onCreated={handleProjectCreated}
            onBack={back}
          />
        )}
        {step === 5 && createdProject && (
          <ReadyStep project={createdProject} onFinish={handleFinish} />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create placeholder step files**

Create all five step files as minimal placeholders so the wizard compiles. Each follows this pattern — here's `WelcomeStep.tsx` as an example:

Create `src/components/onboarding/steps/WelcomeStep.tsx`:
```tsx
export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return <div><button onClick={onNext}>Next (placeholder)</button></div>
}
```

Create `src/components/onboarding/steps/SignInStep.tsx`:
```tsx
export function SignInStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return <div><button onClick={onBack}>Back</button><button onClick={onNext}>Next (placeholder)</button></div>
}
```

Create `src/components/onboarding/steps/NameStep.tsx`:
```tsx
export function NameStep({ value, onChange, onNext, onBack }: { value: string; onChange: (v: string) => void; onNext: () => void; onBack: () => void }) {
  return <div><button onClick={onBack}>Back</button><button onClick={onNext}>Next (placeholder)</button></div>
}
```

Create `src/components/onboarding/steps/ProjectStep.tsx`:
```tsx
import type { ProjectRecord } from "@/lib/parsers/types"
export function ProjectStep({ displayName, onCreated, onBack }: { displayName: string; onCreated: (p: ProjectRecord) => void; onBack: () => void }) {
  return <div><button onClick={onBack}>Back (placeholder)</button></div>
}
```

Create `src/components/onboarding/steps/ReadyStep.tsx`:
```tsx
import type { ProjectRecord } from "@/lib/parsers/types"
export function ReadyStep({ project, onFinish }: { project: ProjectRecord; onFinish: () => void }) {
  return <div><button onClick={onFinish}>Finish (placeholder)</button></div>
}
```

- [ ] **Step 3: Add the `/onboarding` route**

In `src/App.tsx`, add import:
```ts
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
```

Add route inside `<Routes>`, before the catch-all or at the top:
```tsx
      <Route path="/onboarding" element={<OnboardingWizard />} />
```

- [ ] **Step 4: Add Dashboard redirect**

In `src/components/Dashboard.tsx`, add `Navigate` to the react-router-dom import:
```ts
import { useNavigate, Navigate } from "react-router-dom"
```

At the top of the `Dashboard` component body (before the `return`), add:
```ts
  const onboardingComplete = localStorage.getItem("codex:onboardingComplete") === "true"
  if (!onboardingComplete && projects.length === 0) {
    return <Navigate to="/onboarding" replace />
  }
```

This redirects only when onboarding hasn't been completed AND there are no existing projects (so existing users with projects already aren't forced through onboarding).

NOTE: The `projects` state starts as `[]` and loads asynchronously. To avoid a flash-redirect before projects load, wrap the redirect in a loading guard. Modify the existing `useEffect` to track loading state:

```ts
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listProjects().then((p) => {
      setProjects(p)
      setLoading(false)
    })
  }, [])
```

And update the redirect guard:
```ts
  if (!loading && !onboardingComplete && projects.length === 0) {
    return <Navigate to="/onboarding" replace />
  }
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/onboarding/ src/App.tsx src/components/Dashboard.tsx
git commit -m "feat(onboarding): wizard shell with routing + Dashboard redirect"
```

---

## Task 3: WelcomeStep + SignInStep

**Files:**
- Modify: `src/components/onboarding/steps/WelcomeStep.tsx`
- Modify: `src/components/onboarding/steps/SignInStep.tsx`

- [ ] **Step 1: Implement WelcomeStep**

Replace `src/components/onboarding/steps/WelcomeStep.tsx`:

```tsx
import { Button } from "@/components/ui/button"

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Codex</h1>
        <p className="text-muted-foreground">
          A collaborative translation editor with AI assistance.
        </p>
      </div>
      <Button size="lg" onClick={onNext} className="w-full">
        Get Started
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Implement SignInStep**

Replace `src/components/onboarding/steps/SignInStep.tsx`:

```tsx
import { Button } from "@/components/ui/button"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { Check } from "lucide-react"

export function SignInStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { session } = useFrontierSession()

  if (session) {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
            <Check className="h-6 w-6" />
          </div>
          <h2 className="text-2xl font-semibold">Signed in as {session.username}</h2>
          <p className="text-sm text-muted-foreground">
            AI translations, sync, and cloud import are available.
          </p>
        </div>
        <Button size="lg" onClick={onNext} className="w-full">
          Continue
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">Sign in to Frontier</h2>
        <p className="text-sm text-muted-foreground">
          Unlock AI-powered translations, sync across devices, and import projects from the cloud.
        </p>
      </div>
      <FrontierLoginForm onSuccess={onNext} />
      <div className="text-center">
        <button
          onClick={onNext}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Skip for now
        </button>
      </div>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/steps/WelcomeStep.tsx src/components/onboarding/steps/SignInStep.tsx
git commit -m "feat(onboarding): WelcomeStep + SignInStep with Frontier login"
```

---

## Task 4: NameStep + ProjectStep + ReadyStep

**Files:**
- Modify: `src/components/onboarding/steps/NameStep.tsx`
- Modify: `src/components/onboarding/steps/ProjectStep.tsx`
- Modify: `src/components/onboarding/steps/ReadyStep.tsx`
- Modify: `src/components/onboarding/OnboardingWizard.tsx` (wire username into project creation)

- [ ] **Step 1: Implement NameStep**

Replace `src/components/onboarding/steps/NameStep.tsx`:

```tsx
import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useFrontierSession } from "@/hooks/useFrontierSession"

export function NameStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: string
  onChange: (v: string) => void
  onNext: () => void
  onBack: () => void
}) {
  const { session } = useFrontierSession()

  // Pre-fill from Frontier session if user hasn't typed anything yet
  useEffect(() => {
    if (session?.username && !value) {
      onChange(session.username)
    }
  }, [session?.username])

  function handleContinue() {
    const name = value.trim() || "Anonymous"
    localStorage.setItem("codex:username", name)
    onChange(name)
    onNext()
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">What should we call you?</h2>
        <p className="text-sm text-muted-foreground">
          This name appears on your edits and comments.
        </p>
      </div>
      <div>
        <Label htmlFor="display-name">Display name</Label>
        <Input
          id="display-name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Anonymous translator"
          autoFocus
        />
      </div>
      <Button size="lg" onClick={handleContinue} className="w-full">
        Continue
      </Button>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Implement ProjectStep**

Replace `src/components/onboarding/steps/ProjectStep.tsx`:

```tsx
import { useState } from "react"
import { v4 as uuid } from "uuid"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ProjectStep({
  displayName,
  onCreated,
  onBack,
}: {
  displayName: string
  onCreated: (p: ProjectRecord) => void
  onBack: () => void
}) {
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [busy, setBusy] = useState(false)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()) return
    setBusy(true)
    const project: ProjectRecord = {
      id: uuid(),
      name: name.trim(),
      sourceLanguage: sourceLanguage.trim(),
      targetLanguage: targetLanguage.trim(),
      createdAt: new Date().toISOString(),
      files: [],
      members: [{ userId: "local", role: "owner" }],
      username: displayName || "Anonymous",
    }
    await createProject(project)
    onCreated(project)
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">Create your first project</h2>
        <p className="text-sm text-muted-foreground">
          You can import files and invite collaborators after setup.
        </p>
      </div>
      <form onSubmit={handleCreate} className="space-y-4">
        <div>
          <Label htmlFor="proj-name">Project name</Label>
          <Input
            id="proj-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Translation Project"
            autoFocus
          />
        </div>
        <div>
          <Label htmlFor="src-lang">Source language</Label>
          <Input
            id="src-lang"
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value)}
            placeholder="English"
          />
        </div>
        <div>
          <Label htmlFor="tgt-lang">Target language</Label>
          <Input
            id="tgt-lang"
            value={targetLanguage}
            onChange={(e) => setTargetLanguage(e.target.value)}
            placeholder="French"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={busy || !name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()}
        >
          {busy ? "Creating…" : "Create Project"}
        </Button>
      </form>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
```

- [ ] **Step 3: Implement ReadyStep**

Replace `src/components/onboarding/steps/ReadyStep.tsx`:

```tsx
import { Button } from "@/components/ui/button"
import { Check } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ReadyStep({
  project,
  onFinish,
}: {
  project: ProjectRecord
  onFinish: () => void
}) {
  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-green-600">
        <Check className="h-8 w-8" />
      </div>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">You're all set!</h2>
        <p className="text-muted-foreground">
          <strong>{project.name}</strong> is ready. We'll walk you through setting up AI and inviting collaborators next.
        </p>
      </div>
      <Button size="lg" onClick={onFinish} className="w-full">
        Start Translating
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/steps/NameStep.tsx src/components/onboarding/steps/ProjectStep.tsx src/components/onboarding/steps/ReadyStep.tsx
git commit -m "feat(onboarding): NameStep, ProjectStep, ReadyStep — complete wizard flow"
```

---

## Task 5: SetupChecklistDrawer + ComingSoonStep

**Files:**
- Create: `src/components/onboarding/SetupChecklistDrawer.tsx`
- Create: `src/components/onboarding/checklist/ComingSoonStep.tsx`

- [ ] **Step 1: Create ComingSoonStep**

Create `src/components/onboarding/checklist/ComingSoonStep.tsx`:

```tsx
export function ComingSoonStep({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 opacity-60">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/30 text-[10px] text-muted-foreground">
        —
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Coming soon
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create SetupChecklistDrawer**

Create `src/components/onboarding/SetupChecklistDrawer.tsx`:

```tsx
import { useState } from "react"
import { X, Check, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ChecklistState } from "@/hooks/useSetupChecklist"
import type { ProjectRecord } from "@/lib/parsers/types"
import { AiProviderStep } from "./checklist/AiProviderStep"
import { AiInstructionsStep } from "./checklist/AiInstructionsStep"
import { InviteStep } from "./checklist/InviteStep"
import { ComingSoonStep } from "./checklist/ComingSoonStep"

interface SetupChecklistDrawerProps {
  project: ProjectRecord
  state: ChecklistState
  onDismiss: () => void
  onClose: () => void
  onProjectUpdated: (p: ProjectRecord) => void
  onSharesChanged: () => void
}

function ChecklistItem({
  title,
  complete,
  children,
}: {
  title: string
  complete: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(!complete)

  return (
    <div className="rounded-lg border">
      <button
        className="flex w-full items-center gap-3 p-3 text-left text-sm font-medium hover:bg-accent/50"
        onClick={() => setOpen(!open)}
      >
        <div
          className={
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full " +
            (complete ? "bg-green-100 text-green-600" : "border border-muted-foreground/40")
          }
        >
          {complete && <Check className="h-3 w-3" />}
        </div>
        <span className="flex-1">{title}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && <div className="border-t px-3 pb-3 pt-2">{children}</div>}
    </div>
  )
}

export function SetupChecklistDrawer({
  project,
  state,
  onDismiss,
  onClose,
  onProjectUpdated,
  onSharesChanged,
}: SetupChecklistDrawerProps) {
  return (
    <div className="flex h-full w-80 flex-col border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Project Setup</h3>
          <p className="text-xs text-muted-foreground">
            {state.completedCount}/{state.totalCount} complete
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-6 w-6 p-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Checklist */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <ChecklistItem title="Choose AI provider" complete={state.aiProvider}>
          <AiProviderStep project={project} onUpdated={onProjectUpdated} />
        </ChecklistItem>

        <ChecklistItem title="Set AI instructions" complete={state.aiInstructions}>
          <AiInstructionsStep project={project} onUpdated={onProjectUpdated} />
        </ChecklistItem>

        <ChecklistItem title="Invite collaborators" complete={state.collaborators}>
          <InviteStep projectId={project.id} username={project.username || "anonymous"} onSharesChanged={onSharesChanged} />
        </ChecklistItem>

        <ComingSoonStep
          title="Upload project standards"
          description="Upload style guides and translation standards that AI will follow."
        />
        <ComingSoonStep
          title="Import glossary / translation memory"
          description="Import existing translation memories or glossaries to improve consistency."
        />
      </div>

      {/* Footer */}
      <div className="border-t p-4">
        <button
          onClick={onDismiss}
          className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Dismiss checklist
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create placeholder checklist step files**

Create `src/components/onboarding/checklist/AiProviderStep.tsx`:
```tsx
import type { ProjectRecord } from "@/lib/parsers/types"
export function AiProviderStep({ project, onUpdated }: { project: ProjectRecord; onUpdated: (p: ProjectRecord) => void }) {
  return <div>AI Provider (placeholder)</div>
}
```

Create `src/components/onboarding/checklist/AiInstructionsStep.tsx`:
```tsx
import type { ProjectRecord } from "@/lib/parsers/types"
export function AiInstructionsStep({ project, onUpdated }: { project: ProjectRecord; onUpdated: (p: ProjectRecord) => void }) {
  return <div>AI Instructions (placeholder)</div>
}
```

Create `src/components/onboarding/checklist/InviteStep.tsx`:
```tsx
export function InviteStep({ projectId, username, onSharesChanged }: { projectId: string; username: string; onSharesChanged: () => void }) {
  return <div>Invite (placeholder)</div>
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/SetupChecklistDrawer.tsx src/components/onboarding/checklist/
git commit -m "feat(onboarding): SetupChecklistDrawer shell with accordion items + ComingSoonStep"
```

---

## Task 6: AiProviderStep + AiInstructionsStep + InviteStep

**Files:**
- Modify: `src/components/onboarding/checklist/AiProviderStep.tsx`
- Modify: `src/components/onboarding/checklist/AiInstructionsStep.tsx`
- Modify: `src/components/onboarding/checklist/InviteStep.tsx`

- [ ] **Step 1: Implement AiProviderStep**

Replace `src/components/onboarding/checklist/AiProviderStep.tsx`:

```tsx
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateProject } from "@/lib/store/project-index"
import { FRONTIER_CHAT_URL, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ProjectRecord, CompletionProvider } from "@/lib/parsers/types"
import { Check } from "lucide-react"

export function AiProviderStep({
  project,
  onUpdated,
}: {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}) {
  const { session } = useFrontierSession()
  const currentProvider = project.completionSettings?.provider ?? (project.completionSettings?.endpoint ? "custom" : "frontier")
  const [selected, setSelected] = useState<CompletionProvider | "byo">(currentProvider)
  const [customEndpoint, setCustomEndpoint] = useState(
    currentProvider === "custom" ? (project.completionSettings?.endpoint ?? "") : ""
  )
  const [customModel, setCustomModel] = useState(
    currentProvider === "custom" ? (project.completionSettings?.model ?? "") : ""
  )

  async function handleSave() {
    const isFrontier = selected === "frontier"
    const updated: ProjectRecord = {
      ...project,
      completionSettings: {
        provider: isFrontier ? "frontier" : "custom",
        endpoint: isFrontier ? FRONTIER_CHAT_URL : customEndpoint.trim(),
        model: isFrontier ? "" : customModel.trim(),
        maxTokens: project.completionSettings?.maxTokens ?? 512,
        temperature: project.completionSettings?.temperature ?? 0.3,
        systemPrompt: project.completionSettings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        llmHealthPenalty: project.completionSettings?.llmHealthPenalty ?? 0.1,
      },
    }
    await updateProject(updated)
    onUpdated(updated)
  }

  const canSave = selected === "frontier"
    ? true
    : selected === "custom" ? Boolean(customEndpoint.trim()) : false

  return (
    <div className="space-y-3">
      {/* Frontier AI */}
      <button
        className={
          "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors " +
          (selected === "frontier" ? "border-primary bg-primary/5" : "hover:bg-accent/50")
        }
        onClick={() => setSelected("frontier")}
      >
        <div className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border " + (selected === "frontier" ? "border-primary bg-primary text-primary-foreground" : "")}>
          {selected === "frontier" && <Check className="h-2.5 w-2.5" />}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Frontier AI</span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Recommended</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {session ? `Connected as ${session.username}` : "Sign in to use Frontier AI"}
          </p>
        </div>
      </button>

      {/* Custom endpoint */}
      <button
        className={
          "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors " +
          (selected === "custom" ? "border-primary bg-primary/5" : "hover:bg-accent/50")
        }
        onClick={() => setSelected("custom")}
      >
        <div className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border " + (selected === "custom" ? "border-primary bg-primary text-primary-foreground" : "")}>
          {selected === "custom" && <Check className="h-2.5 w-2.5" />}
        </div>
        <div>
          <span className="text-sm font-medium">Custom endpoint</span>
          <p className="mt-0.5 text-xs text-muted-foreground">Self-hosted or local OpenAI-compatible server</p>
        </div>
      </button>

      {selected === "custom" && (
        <div className="ml-7 space-y-2">
          <div>
            <Label className="text-xs">Endpoint URL</Label>
            <Input value={customEndpoint} onChange={(e) => setCustomEndpoint(e.target.value)} placeholder="http://localhost:8000" className="text-sm" />
          </div>
          <div>
            <Label className="text-xs">Model (optional)</Label>
            <Input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="gpt-4" className="text-sm" />
          </div>
        </div>
      )}

      {/* Bring your own keys — coming soon */}
      <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 opacity-50">
        <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border">—</div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">Bring your own keys</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Coming soon</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Use your own API keys for OpenAI, Anthropic, etc.</p>
        </div>
      </div>

      <Button size="sm" onClick={handleSave} disabled={!canSave} className="w-full">
        Save
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Implement AiInstructionsStep**

Replace `src/components/onboarding/checklist/AiInstructionsStep.tsx`:

```tsx
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { updateProject } from "@/lib/store/project-index"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import type { ProjectRecord } from "@/lib/parsers/types"

export function AiInstructionsStep({
  project,
  onUpdated,
}: {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}) {
  const [prompt, setPrompt] = useState(
    project.completionSettings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  )

  async function handleSave() {
    const updated: ProjectRecord = {
      ...project,
      completionSettings: {
        provider: project.completionSettings?.provider ?? "frontier",
        endpoint: project.completionSettings?.endpoint ?? "",
        model: project.completionSettings?.model ?? "",
        maxTokens: project.completionSettings?.maxTokens ?? 512,
        temperature: project.completionSettings?.temperature ?? 0.3,
        systemPrompt: prompt,
        llmHealthPenalty: project.completionSettings?.llmHealthPenalty ?? 0.1,
      },
    }
    await updateProject(updated)
    onUpdated(updated)
  }

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">System prompt</Label>
        <p className="mb-1 text-[11px] text-muted-foreground">
          Instructions the AI follows when generating translations. Use {"{sourceLanguage}"} and {"{targetLanguage}"} as placeholders.
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="mt-1 text-right text-[10px] text-muted-foreground">
          {prompt.length} characters
        </p>
      </div>
      <Button size="sm" onClick={handleSave} className="w-full">
        Save Instructions
      </Button>
    </div>
  )
}
```

- [ ] **Step 3: Implement InviteStep**

Replace `src/components/onboarding/checklist/InviteStep.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react"
import { Copy, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { listShares, createShare } from "@/lib/sync/share-tokens"
import type { ShareInvite } from "@/lib/parsers/types"

export function InviteStep({
  projectId,
  username,
  onSharesChanged,
}: {
  projectId: string
  username: string
  onSharesChanged: () => void
}) {
  const [shares, setShares] = useState<ShareInvite[]>([])
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    const list = await listShares(projectId)
    setShares(list)
    onSharesChanged()
  }, [projectId, onSharesChanged])

  useEffect(() => { refresh() }, [refresh])

  async function handleCreate() {
    await createShare(projectId, undefined, username)
    await refresh()
  }

  function copyUrl(token: string) {
    const url = `${window.location.origin}/join/${token}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (shares.length === 0) {
    return (
      <div className="space-y-2 text-center">
        <p className="text-xs text-muted-foreground">
          Share a link with translators and reviewers to collaborate in real-time.
        </p>
        <Button size="sm" variant="outline" onClick={handleCreate} className="w-full">
          <Plus className="mr-1.5 h-3 w-3" /> Create share link
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {shares.map((share) => (
        <div key={share.token} className="flex items-center gap-1">
          <input
            value={`${window.location.origin}/join/${share.token}`}
            readOnly
            className="flex-1 rounded border bg-muted/30 px-2 py-1 text-xs font-mono"
          />
          <Button size="sm" variant="ghost" onClick={() => copyUrl(share.token)} className="h-7 w-7 p-0">
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      ))}
      {copied && <p className="text-xs text-green-600">Copied!</p>}
      <Button size="sm" variant="outline" onClick={handleCreate} className="w-full">
        <Plus className="mr-1.5 h-3 w-3" /> Create another link
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/checklist/AiProviderStep.tsx src/components/onboarding/checklist/AiInstructionsStep.tsx src/components/onboarding/checklist/InviteStep.tsx
git commit -m "feat(onboarding): AI provider, instructions, and invite checklist steps"
```

---

## Task 7: Wire checklist into ProjectWorkspace + Toolbar progress pill

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx`
- Modify: `src/components/Toolbar.tsx`

- [ ] **Step 1: Mount the checklist drawer in ProjectWorkspace**

In `src/components/ProjectWorkspace.tsx`:

Add imports:
```ts
import { useSetupChecklist } from "@/hooks/useSetupChecklist"
import { SetupChecklistDrawer } from "./onboarding/SetupChecklistDrawer"
```

Inside the component, after the `useCorpusBackfill(...)` call, add:
```ts
  const { state: checklistState, dismissed: checklistDismissed, dismiss: dismissChecklist, refreshShares: refreshChecklistShares } = useSetupChecklist(project ?? null)
  const [checklistOpen, setChecklistOpen] = useState(!checklistDismissed)
```

Add an effect to auto-open on first visit (when not dismissed):
```ts
  useEffect(() => {
    if (!checklistDismissed) setChecklistOpen(true)
  }, [checklistDismissed])
```

In the JSX, after the `{historyCell && (...)}` block (inside `<main>`, at the right side alongside other drawers), add:
```tsx
          {checklistOpen && !checklistDismissed && project && (
            <SetupChecklistDrawer
              project={project}
              state={checklistState}
              onDismiss={() => { dismissChecklist(); setChecklistOpen(false) }}
              onClose={() => setChecklistOpen(false)}
              onProjectUpdated={handleProjectUpdated}
              onSharesChanged={refreshChecklistShares}
            />
          )}
```

- [ ] **Step 2: Add progress pill + login button to Toolbar**

In `src/components/Toolbar.tsx`:

Add to imports:
```ts
import { HeaderAuth } from "@/components/git-import/HeaderAuth"
```

Add to `ToolbarProps`:
```ts
  checklistProgress?: { completed: number; total: number }
  onOpenChecklist?: () => void
```

Add to the destructured args:
```ts
  checklistProgress, onOpenChecklist,
```

Render the progress pill + HeaderAuth before the Settings button at the end of the toolbar. Find the `<Button variant="ghost" size="sm" onClick={onSettings}>` block and add before it:

```tsx
      {checklistProgress && checklistProgress.completed < checklistProgress.total && onOpenChecklist && (
        <button
          onClick={onOpenChecklist}
          className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent"
          title="Open setup checklist"
        >
          Setup: {checklistProgress.completed}/{checklistProgress.total}
        </button>
      )}
      <HeaderAuth />
```

Pass these from ProjectWorkspace to Toolbar:
```tsx
        checklistProgress={checklistDismissed ? undefined : { completed: checklistState.completedCount, total: checklistState.totalCount }}
        onOpenChecklist={() => setChecklistOpen(true)}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProjectWorkspace.tsx src/components/Toolbar.tsx
git commit -m "feat(onboarding): wire SetupChecklistDrawer into workspace + Toolbar progress pill"
```

---

## Task 8: Anonymous sparkle tooltip + ProjectSettings checklist button

**Files:**
- Modify: `src/components/EditorTable.tsx`
- Modify: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Update sparkle tooltip for anonymous users**

In `src/components/EditorTable.tsx`:

Add to `EditorTableProps`:
```ts
  isAnonymous?: boolean
```

Add to the destructured args of the `forwardRef` callback.

Pass it through to `EditorRow` — add to `EditorRowProps`:
```ts
  isAnonymous?: boolean
```

Pass from the parent map callback:
```tsx
                isAnonymous={isAnonymous}
```

Inside `EditorRow`, find where `SparkleButton` is rendered (around line 381-388). The existing `tooltip` prop uses a ternary. Change it to:

```tsx
        <SparkleButton
          disabled={!isCompletionConfigured || !editable || isAnonymous}
          loading={isLoading}
          onComplete={() => onCompleteSingle(cell)}
          onDragStart={onDragStart}
          onDragEnter={onDragEnter}
          tooltip={
            isAnonymous
              ? "Sign in for AI translations"
              : !editable
                ? "Read-only (imported from git)"
                : isCompletionConfigured
                  ? "Generate translation"
                  : "Configure LLM in settings"
          }
        />
```

In `src/components/ProjectWorkspace.tsx`, pass the new prop to `<EditorTable>`:
```tsx
                isAnonymous={!frontierSession}
```

(Use the existing `frontierSession` from `useFrontierSession()` which is already called via `const { session: frontierSession } = useFrontierSession()`.)

- [ ] **Step 2: Add "View setup checklist" button to ProjectSettings**

In `src/components/ProjectSettings.tsx`, find the return JSX. Add a button near the top of the settings page, after the "← Back" button / header area. Look for the navigation area and add:

```tsx
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/project/${id}`)}
            >
              View Setup Checklist
            </Button>
```

This navigates back to the workspace where the checklist will auto-open if not dismissed. (A more precise approach would pass a query param like `?checklist=open`, but navigating back and having the drawer auto-open from the `!checklistDismissed` state is sufficient for v1.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/EditorTable.tsx src/components/ProjectWorkspace.tsx src/components/ProjectSettings.tsx
git commit -m "feat(onboarding): anonymous sparkle tooltip + settings checklist link"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass including the new `useSetupChecklist` tests.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Lint our new files**

Run: `npx eslint src/components/onboarding/ src/hooks/useSetupChecklist.ts`
Expected: No new errors. If there are react-refresh violations (e.g. exporting a hook + component from the same file), extract the hook into a separate file.

- [ ] **Step 5: End-to-end smoke**

Run `npm run dev`. Walk through:

1. **Clear localStorage** (`localStorage.removeItem("codex:onboardingComplete")`) and delete all projects from IndexedDB, then refresh.
2. Verify redirect to `/onboarding`.
3. Walk through all 5 wizard steps — Welcome, Sign In (skip or sign in), Name, Create Project, Ready.
4. Verify landing on the project workspace with the setup checklist drawer open.
5. Complete the AI provider step (select Frontier), save.
6. Complete the AI instructions step (keep default or edit), save.
7. Create a share link in the invite step.
8. Verify progress pill in Toolbar updates (3/3).
9. Dismiss the checklist.
10. Navigate to Project Settings — verify "View Setup Checklist" button exists.
11. Refresh the page — verify the project stays open (URL routing from the QoL feature).
12. If testing anonymous: clear session, open a project, hover the sparkle — verify "Sign in for AI translations" tooltip. Verify the login button appears in the Toolbar header.

- [ ] **Step 6: No commit needed**

All work is committed in prior tasks. Fix any issues found during smoke in follow-up commits.

---

## Self-review

**Spec coverage:**
- Part 1 (wizard): Steps 1-5 → Tasks 2, 3, 4. First-run detection + routing → Task 2. ✓
- Part 2 (checklist): Drawer shell → Task 5. Active items → Task 6. Coming soon → Task 5. Wiring → Task 7. Dismiss + re-access → Tasks 5, 7, 8. ✓
- Part 3 (anonymous): Sparkle tooltip → Task 8. Header login → Task 7. ✓
- Schema change → Task 1. ✓

**Type consistency:** `ChecklistState` defined in Task 1, consumed in Tasks 5, 7. `ProjectRecord` augmented in Task 1 with `setupChecklistDismissed`, used in Tasks 5, 7. `CompletionProvider` and `FRONTIER_CHAT_URL` imported from existing modules. ✓

**No placeholders found.** Every step has actual code.
