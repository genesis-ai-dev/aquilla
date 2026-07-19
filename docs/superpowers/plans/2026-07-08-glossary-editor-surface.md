# Glossary Editor Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the card-based terminology page with a source-left/target-right editor-like surface, opened as a pinned pseudo-"file" in the project, keeping the existing `Concept[]` model and all downstream (blots/injection/violations) untouched.

**Architecture:** A lookalike editor surface (Model B) over the existing `ProjectRecord.terminology: Concept[]`. New pure helpers derive a concept's "primary rendering"; a new `GlossaryRow` renders one concept as source + primary-target + an expander for the full rendering set; a new `GlossaryEditor` lists rows by lifecycle status (active / suggested / archived), owns persistence via `patchSettings({ terminology })`, and reuses the existing `store.ts` mutation helpers. `ProjectWorkspace` renders `GlossaryEditor` on the existing `/project/:id/terminology` route, and `ExpandableFileList` gains a pinned "Glossary" entry that routes there.

**Tech Stack:** React 19, TypeScript (no `any`), Tailwind v4, shadcn/ui + @base-ui/react, lucide icons, Vitest + happy-dom + @testing-library/react, react-router-dom.

## Global Constraints

- TypeScript, no `any`. Use `const`/`let`, arrow fns, `?.`/`??`.
- Use `@/` path alias (resolves to `./src`).
- Component files target ≤ ~500 lines; split by responsibility.
- Persistence is `patchSettings({ terminology: Concept[] })` from `useProject(id)` — never write `terminology` any other way. `patchSettings` returns a promise resolving to `{ kind: "ok" } | ...`.
- Concept mutations go through the existing pure helpers in `@/lib/terminology/store` (they take a `ProjectRecord`, return an updated `ProjectRecord`; read `.terminology ?? []` off the result to persist).
- Role gate: managing termbase definitions requires level ≥ 500, OR a local project (no `project.origin`). Reuse the `canEditTermbase(syncRole, hasOrigin)` rule (extracted in Task 1).
- Concept status vocabulary: `active` = approved, `draft` = suggested, `deprecated` = archived. Blots / prompt-injection / rule-compilation already consume **only** `active` concepts — do not change that.
- Vitest lives beside source as `*.test.ts(x)`. Run a single file with `pnpm test <path>`.

---

### Task 1: Pure glossary-view helpers + role gate

**Files:**
- Create: `src/lib/terminology/glossary-view.ts`
- Test: `src/lib/terminology/glossary-view.test.ts`

**Interfaces:**
- Consumes: `Concept`, `TermRendering` from `@/lib/terminology/types`.
- Produces:
  - `primaryRendering(concept: Concept): TermRendering | null`
  - `setPrimaryRendering(concept: Concept, text: string): Concept`
  - `partitionConcepts(concepts: Concept[]): { active: Concept[]; suggested: Concept[]; archived: Concept[] }`
  - `canEditTermbase(syncRole?: { level: number } | null, hasOrigin?: boolean): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/terminology/glossary-view.test.ts
import { describe, it, expect } from "vitest"
import {
  primaryRendering,
  setPrimaryRendering,
  partitionConcepts,
  canEditTermbase,
} from "./glossary-view"
import type { Concept } from "./types"

function c(partial: Partial<Concept>): Concept {
  return {
    id: "x",
    sourceTerm: "grace",
    renderings: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  }
}

describe("primaryRendering", () => {
  it("returns the first preferred rendering when present", () => {
    const concept = c({
      renderings: [
        { rendering: "gracia", status: "admitted" },
        { rendering: "favor", status: "preferred" },
      ],
    })
    expect(primaryRendering(concept)?.rendering).toBe("favor")
  })

  it("falls back to the first rendering when none are preferred", () => {
    const concept = c({ renderings: [{ rendering: "gracia", status: "admitted" }] })
    expect(primaryRendering(concept)?.rendering).toBe("gracia")
  })

  it("returns null when there are no renderings", () => {
    expect(primaryRendering(c({ renderings: [] }))).toBeNull()
  })
})

describe("setPrimaryRendering", () => {
  it("mutates the existing preferred rendering", () => {
    const concept = c({
      renderings: [
        { rendering: "favor", status: "preferred" },
        { rendering: "gracia", status: "admitted" },
      ],
    })
    const next = setPrimaryRendering(concept, "merced")
    expect(next.renderings).toEqual([
      { rendering: "merced", status: "preferred" },
      { rendering: "gracia", status: "admitted" },
    ])
  })

  it("mutates the first rendering when none is preferred", () => {
    const concept = c({ renderings: [{ rendering: "gracia", status: "admitted" }] })
    const next = setPrimaryRendering(concept, "merced")
    expect(next.renderings).toEqual([{ rendering: "merced", status: "admitted" }])
  })

  it("adds a preferred rendering when there are none", () => {
    const next = setPrimaryRendering(c({ renderings: [] }), "merced")
    expect(next.renderings).toEqual([{ rendering: "merced", status: "preferred" }])
  })

  it("does not mutate the input concept", () => {
    const concept = c({ renderings: [{ rendering: "favor", status: "preferred" }] })
    setPrimaryRendering(concept, "merced")
    expect(concept.renderings[0].rendering).toBe("favor")
  })
})

describe("partitionConcepts", () => {
  it("splits by lifecycle status", () => {
    const parts = partitionConcepts([
      c({ id: "a", status: "active" }),
      c({ id: "d", status: "draft" }),
      c({ id: "x", status: "deprecated" }),
      c({ id: "a2", status: "active" }),
    ])
    expect(parts.active.map((x) => x.id)).toEqual(["a", "a2"])
    expect(parts.suggested.map((x) => x.id)).toEqual(["d"])
    expect(parts.archived.map((x) => x.id)).toEqual(["x"])
  })
})

describe("canEditTermbase", () => {
  it("allows local projects regardless of role", () => {
    expect(canEditTermbase(null, false)).toBe(true)
    expect(canEditTermbase({ level: 100 }, false)).toBe(true)
  })
  it("allows when role not yet cached on a cloud project", () => {
    expect(canEditTermbase(null, true)).toBe(true)
  })
  it("requires level >= 500 on a cloud project", () => {
    expect(canEditTermbase({ level: 400 }, true)).toBe(false)
    expect(canEditTermbase({ level: 500 }, true)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/terminology/glossary-view.test.ts`
Expected: FAIL — cannot resolve `./glossary-view`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/terminology/glossary-view.ts
/**
 * Pure view-model helpers for the glossary editor surface.
 *
 * The editor shows one row per Concept: a source headword and a single
 * "primary" target rendering, with the full rendering set behind an expander.
 * These helpers derive/update that primary rendering and partition concepts by
 * lifecycle status. No side effects — callers persist via patchSettings.
 */
import type { Concept, TermRendering } from "./types"

/** The rendering shown in the row's target cell: first preferred, else first, else null. */
export function primaryRendering(concept: Concept): TermRendering | null {
  const preferred = concept.renderings.find((r) => r.status === "preferred")
  if (preferred) return preferred
  return concept.renderings[0] ?? null
}

/**
 * Update the primary rendering's text. Mutates the same rendering
 * `primaryRendering` would return: the first preferred, else the first, else
 * adds a new `preferred` rendering. Returns a new Concept (input unchanged).
 */
export function setPrimaryRendering(concept: Concept, text: string): Concept {
  const preferredIdx = concept.renderings.findIndex((r) => r.status === "preferred")
  const targetIdx = preferredIdx >= 0 ? preferredIdx : concept.renderings.length > 0 ? 0 : -1
  if (targetIdx === -1) {
    return { ...concept, renderings: [{ rendering: text, status: "preferred" }] }
  }
  return {
    ...concept,
    renderings: concept.renderings.map((r, i) =>
      i === targetIdx ? { ...r, rendering: text } : r,
    ),
  }
}

export interface GlossaryPartition {
  active: Concept[]
  suggested: Concept[]
  archived: Concept[]
}

/** Split concepts into lifecycle buckets, preserving order within each bucket. */
export function partitionConcepts(concepts: Concept[]): GlossaryPartition {
  const active: Concept[] = []
  const suggested: Concept[] = []
  const archived: Concept[] = []
  for (const concept of concepts) {
    if (concept.status === "active") active.push(concept)
    else if (concept.status === "draft") suggested.push(concept)
    else archived.push(concept)
  }
  return { active, suggested, archived }
}

/** Level at which a user may manage termbase definitions. */
const TERMBASE_EDIT_LEVEL = 500

/**
 * May the user add/edit/delete/archive concepts? Local projects (no origin)
 * and not-yet-cached cloud roles are optimistically allowed; the server
 * enforces the real gate. Mirrors the rule previously local to TerminologyPage.
 */
export function canEditTermbase(
  syncRole?: { level: number } | null,
  hasOrigin?: boolean,
): boolean {
  if (!hasOrigin) return true
  if (!syncRole) return true
  return syncRole.level >= TERMBASE_EDIT_LEVEL
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/terminology/glossary-view.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminology/glossary-view.ts src/lib/terminology/glossary-view.test.ts
git commit -m "feat(terminology): glossary-view helpers (primary rendering, partition, role gate)"
```

---

### Task 2: `GlossaryRow` component

Renders one concept as an editor-like row: inline-editable source (left) and primary rendering (right), an expander for the full rendering set, and lifecycle affordances. Presentational only — all mutations bubble up through callbacks; no data fetching.

**Files:**
- Create: `src/components/GlossaryRow.tsx`
- Test: `src/components/GlossaryRow.test.tsx`

**Interfaces:**
- Consumes: `primaryRendering` from `@/lib/terminology/glossary-view`; `Concept`, `TermRendering`, `RenderingStatus` from `@/lib/terminology/types`; shadcn `Input`, `Select*`, `Button`; lucide icons.
- Produces:
  ```ts
  export interface GlossaryRowProps {
    concept: Concept
    canManage: boolean
    onEditSource: (id: string, sourceTerm: string) => void
    onEditPrimary: (id: string, text: string) => void
    onEditRenderings: (id: string, renderings: TermRendering[]) => void
    onArchive: (id: string) => void
    onRestore: (id: string) => void
    onAccept: (id: string) => void
    onDismiss: (id: string) => void
  }
  export function GlossaryRow(props: GlossaryRowProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/GlossaryRow.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { GlossaryRow } from "./GlossaryRow"
import type { Concept } from "@/lib/terminology/types"

function c(partial: Partial<Concept>): Concept {
  return {
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "favor", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  }
}

function noopHandlers() {
  return {
    onEditSource: vi.fn(),
    onEditPrimary: vi.fn(),
    onEditRenderings: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
  }
}

describe("GlossaryRow", () => {
  it("shows source headword and primary rendering", () => {
    render(<GlossaryRow concept={c({})} canManage {...noopHandlers()} />)
    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.getByText("favor")).toBeInTheDocument()
  })

  it("commits an edited primary rendering on blur", () => {
    const h = noopHandlers()
    render(<GlossaryRow concept={c({})} canManage {...h} />)
    fireEvent.click(screen.getByText("favor"))
    const input = screen.getByDisplayValue("favor")
    fireEvent.change(input, { target: { value: "merced" } })
    fireEvent.blur(input)
    expect(h.onEditPrimary).toHaveBeenCalledWith("c1", "merced")
  })

  it("offers Accept/Dismiss for a suggested (draft) concept", () => {
    const h = noopHandlers()
    render(<GlossaryRow concept={c({ status: "draft" })} canManage {...h} />)
    fireEvent.click(screen.getByRole("button", { name: /accept/i }))
    expect(h.onAccept).toHaveBeenCalledWith("c1")
  })

  it("offers Restore for an archived (deprecated) concept", () => {
    const h = noopHandlers()
    render(<GlossaryRow concept={c({ status: "deprecated" })} canManage {...h} />)
    fireEvent.click(screen.getByRole("button", { name: /restore/i }))
    expect(h.onRestore).toHaveBeenCalledWith("c1")
  })

  it("hides edit affordances when canManage is false", () => {
    render(<GlossaryRow concept={c({})} canManage={false} {...noopHandlers()} />)
    fireEvent.click(screen.getByText("favor"))
    expect(screen.queryByDisplayValue("favor")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/GlossaryRow.test.tsx`
Expected: FAIL — cannot resolve `./GlossaryRow`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/GlossaryRow.tsx
/**
 * GlossaryRow — one concept as an editor-like row.
 *
 * Left: source headword (inline-editable). Right: primary rendering
 * (inline-editable), with an expander revealing the full rendering set and
 * their statuses. Lifecycle affordances vary by concept.status:
 *   active     → Archive
 *   draft      → Accept / Dismiss (rendered ghosted)
 *   deprecated → Restore (rendered dimmed)
 * Presentational only; all mutations bubble through callbacks.
 */
import { useState } from "react"
import { ChevronDown, ChevronRight, Archive, RotateCcw, Check, X, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Concept, TermRendering, RenderingStatus } from "@/lib/terminology/types"
import { primaryRendering } from "@/lib/terminology/glossary-view"
import { cn } from "@/lib/utils"

const RENDERING_STATUS_OPTIONS: { value: RenderingStatus; label: string }[] = [
  { value: "preferred", label: "required" },
  { value: "admitted", label: "alternate" },
  { value: "forbidden", label: "forbidden" },
]

export interface GlossaryRowProps {
  concept: Concept
  canManage: boolean
  onEditSource: (id: string, sourceTerm: string) => void
  onEditPrimary: (id: string, text: string) => void
  onEditRenderings: (id: string, renderings: TermRendering[]) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onAccept: (id: string) => void
  onDismiss: (id: string) => void
}

/** A single inline-editable text cell: click to edit, commit on blur/Enter. */
function InlineCell({
  value,
  placeholder,
  editable,
  onCommit,
  className,
}: {
  value: string
  placeholder: string
  editable: boolean
  onCommit: (next: string) => void
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (editing && editable) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (draft !== value) onCommit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") {
            setDraft(value)
            setEditing(false)
          }
        }}
        className={cn("h-8 text-sm", className)}
      />
    )
  }
  return (
    <button
      type="button"
      className={cn(
        "w-full text-left text-sm leading-relaxed rounded px-1 -mx-1",
        editable && "cursor-text hover:bg-muted/50 transition-colors",
        !value.trim() && "text-muted-foreground italic",
        className,
      )}
      onClick={() => {
        if (editable) {
          setDraft(value)
          setEditing(true)
        }
      }}
    >
      {value.trim() || placeholder}
    </button>
  )
}

export function GlossaryRow({
  concept,
  canManage,
  onEditSource,
  onEditPrimary,
  onEditRenderings,
  onArchive,
  onRestore,
  onAccept,
  onDismiss,
}: GlossaryRowProps) {
  const [expanded, setExpanded] = useState(false)
  const primary = primaryRendering(concept)

  const updateRendering = (index: number, next: TermRendering) =>
    onEditRenderings(
      concept.id,
      concept.renderings.map((r, i) => (i === index ? next : r)),
    )
  const removeRendering = (index: number) =>
    onEditRenderings(
      concept.id,
      concept.renderings.filter((_, i) => i !== index),
    )
  const addRendering = () =>
    onEditRenderings(concept.id, [
      ...concept.renderings,
      { rendering: "", status: "admitted" },
    ])

  return (
    <div
      className={cn(
        "border-b last:border-0",
        concept.status === "draft" && "bg-amber-50/40 dark:bg-amber-950/20",
        concept.status === "deprecated" && "opacity-60",
      )}
      data-status={concept.status}
    >
      <div className="flex items-start gap-3 px-3 py-2">
        {/* Expander toggle */}
        <button
          type="button"
          aria-label={expanded ? "Collapse renderings" : "Expand renderings"}
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {/* Source (left) */}
        <div className="flex-1 min-w-0">
          <InlineCell
            value={concept.sourceTerm}
            placeholder="(source term)"
            editable={canManage}
            onCommit={(next) => onEditSource(concept.id, next)}
          />
        </div>

        {/* Primary rendering (right) */}
        <div className="flex-1 min-w-0">
          <InlineCell
            value={primary?.rendering ?? ""}
            placeholder="(add rendering)"
            editable={canManage}
            onCommit={(next) => onEditPrimary(concept.id, next)}
          />
        </div>

        {/* Lifecycle affordances */}
        <div className="flex shrink-0 items-center gap-1">
          {concept.status === "draft" && canManage && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label="Accept term" onClick={() => onAccept(concept.id)}>
                <Check className="h-4 w-4 text-emerald-600" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss term" onClick={() => onDismiss(concept.id)}>
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
          {concept.status === "active" && canManage && (
            <Button variant="ghost" size="icon-sm" aria-label="Archive term" onClick={() => onArchive(concept.id)}>
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {concept.status === "deprecated" && canManage && (
            <Button variant="ghost" size="icon-sm" aria-label="Restore term" onClick={() => onRestore(concept.id)}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Expander: full rendering set */}
      {expanded && (
        <div className="space-y-1.5 border-t bg-muted/30 px-10 py-2">
          {concept.renderings.length === 0 && (
            <p className="text-xs text-muted-foreground">No renderings yet.</p>
          )}
          {concept.renderings.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r.rendering}
                placeholder="rendering"
                disabled={!canManage}
                className="h-7 flex-1 text-sm"
                onChange={(e) => updateRendering(i, { ...r, rendering: e.target.value })}
              />
              <Select
                items={RENDERING_STATUS_OPTIONS}
                value={r.status}
                onValueChange={(v: string | null) =>
                  updateRendering(i, { ...r, status: (v ?? r.status) as RenderingStatus })
                }
              >
                <SelectTrigger aria-label={`Rendering ${i + 1} status`} className="h-7 w-32 text-xs" disabled={!canManage}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {RENDERING_STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {canManage && (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove rendering ${i + 1}`} onClick={() => removeRendering(i)}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {canManage && (
            <Button variant="ghost" size="sm" className="text-xs" onClick={addRendering}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add rendering
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
```

> **Note on the `Select` prop name:** the shadcn wrapper in this repo may expose the change handler as `onValueChange` **or** `onValueChange`-equivalent. Verify against `src/components/ui/select.tsx` and `src/components/TerminologyPage.tsx` (its `RenderingRow` uses the same Select). Match whichever this repo uses; do not introduce a new prop shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/GlossaryRow.test.tsx`
Expected: PASS. If the Select interaction warns under happy-dom, see the "Base UI + happy-dom test quirks" convention (label-click / keyboard) — the tests above only assert text + inline-cell + lifecycle buttons, avoiding Select interaction.

- [ ] **Step 5: Commit**

```bash
git add src/components/GlossaryRow.tsx src/components/GlossaryRow.test.tsx
git commit -m "feat(terminology): GlossaryRow — editor-like concept row with expander"
```

---

### Task 3: `GlossaryEditor` surface

The two-column surface that lists rows by lifecycle bucket, owns persistence, the "new term" append row, the "Show archived" toggle, import/export, and candidate mining. Self-contained (reads route + project like `TerminologyPage`).

**Files:**
- Create: `src/components/GlossaryEditor.tsx`
- Test: `src/components/GlossaryEditor.test.tsx`

**Interfaces:**
- Consumes: `useProject` (`@/hooks/useProject`), `useProjectCells` (`@/hooks/useProjectCells`), `useFrontierSession`, `useParams`; `store.ts` helpers (`addConcept`, `updateConcept`, `deleteConcept`, `approveConcept`, `rejectConcept`); `partitionConcepts`, `setPrimaryRendering`, `canEditTermbase` (Task 1); `GlossaryRow` (Task 2); `extractCandidates` (`@/lib/terminology/candidates`); `importConceptsCsv/exportConceptsCsv`, `importConceptsTbx/exportConceptsTbx`.
- Produces: `export function GlossaryEditor(): JSX.Element` (default surface for the `/terminology` route).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/GlossaryEditor.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { Concept } from "@/lib/terminology/types"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useParams: () => ({ id: "p1" }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { username: "tester" }, loading: false }),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: () => ({ files: [], isTruncated: false }),
}))

const patchSettings = vi.fn().mockResolvedValue({ kind: "ok" })
let mockProject: ProjectRecord
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ project: mockProject, loading: false, patchSettings }),
}))

import { GlossaryEditor } from "./GlossaryEditor"

function concept(p: Partial<Concept>): Concept {
  return {
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "favor", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  }
}

beforeEach(() => {
  patchSettings.mockClear()
  mockProject = {
    id: "p1",
    name: "P",
    terminology: [concept({})],
  } as unknown as ProjectRecord
})

function renderEditor() {
  return render(
    <MemoryRouter>
      <GlossaryEditor />
    </MemoryRouter>,
  )
}

describe("GlossaryEditor", () => {
  it("renders active concepts as rows", () => {
    renderEditor()
    expect(screen.getByText("grace")).toBeInTheDocument()
    expect(screen.getByText("favor")).toBeInTheDocument()
  })

  it("hides archived concepts until 'Show archived' is toggled", () => {
    mockProject.terminology = [concept({ id: "z", sourceTerm: "wrath", status: "deprecated" })]
    renderEditor()
    expect(screen.queryByText("wrath")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /show archived/i }))
    expect(screen.getByText("wrath")).toBeInTheDocument()
  })

  it("archiving an active concept persists status=deprecated", async () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: /archive term/i }))
    await waitFor(() => expect(patchSettings).toHaveBeenCalled())
    const arg = patchSettings.mock.calls[0][0] as { terminology: Concept[] }
    expect(arg.terminology[0].status).toBe("deprecated")
  })

  it("adding a term via the append row persists a new active concept", async () => {
    renderEditor()
    fireEvent.change(screen.getByPlaceholderText(/new source term/i), {
      target: { value: "mercy" },
    })
    fireEvent.change(screen.getByPlaceholderText(/rendering/i), {
      target: { value: "misericordia" },
    })
    fireEvent.click(screen.getByRole("button", { name: /add term/i }))
    await waitFor(() => expect(patchSettings).toHaveBeenCalled())
    const arg = patchSettings.mock.calls[0][0] as { terminology: Concept[] }
    const added = arg.terminology.find((c) => c.sourceTerm === "mercy")
    expect(added?.status).toBe("active")
    expect(added?.renderings).toEqual([{ rendering: "misericordia", status: "preferred" }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/GlossaryEditor.test.tsx`
Expected: FAIL — cannot resolve `./GlossaryEditor`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/GlossaryEditor.tsx
/**
 * GlossaryEditor — the terminology surface, shaped like the translation editor.
 *
 * One row per concept (source left, primary rendering right), grouped by
 * lifecycle: suggested (draft) at top as pending rows, active in the middle,
 * archived (deprecated) hidden behind a toggle. A persistent append row adds
 * new terms. Persistence is patchSettings({ terminology }); all concept
 * mutations reuse the pure helpers in lib/terminology/store.
 *
 * The Concept[] model is unchanged, so blots / prompt-injection / violation
 * compilation (which read active concepts) need no changes.
 */
import { useMemo, useState, useCallback, useRef, useEffect } from "react"
import { useParams } from "react-router-dom"
import { BookOpen, Download, Upload, Sparkles, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useProject } from "@/hooks/useProject"
import { useProjectCells } from "@/hooks/useProjectCells"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { Concept, TermRendering } from "@/lib/terminology/types"
import {
  addConcept,
  updateConcept,
  deleteConcept,
  approveConcept,
  rejectConcept,
} from "@/lib/terminology/store"
import {
  partitionConcepts,
  setPrimaryRendering,
  canEditTermbase,
} from "@/lib/terminology/glossary-view"
import { extractCandidates } from "@/lib/terminology/candidates"
import { importConceptsCsv, exportConceptsCsv } from "@/lib/terminology/csv"
import { importConceptsTbx, exportConceptsTbx } from "@/lib/terminology/tbx"
import { GlossaryRow } from "@/components/GlossaryRow"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function GlossaryEditor() {
  const { id } = useParams<{ id: string }>()
  const { project, loading, patchSettings } = useProject(id!)
  const { session: frontierSession } = useFrontierSession()

  // Cells are needed only for candidate mining ("Suggest terms"). Wire the
  // token fetcher exactly like TerminologyPage so useProjectCells can fetch.
  const jwtRef = useRef<string | null>(null)
  useEffect(() => {
    jwtRef.current = frontierSession?.jwt ?? null
  }, [frontierSession?.jwt])

  const projectFiles = useMemo(
    () => (project?.files ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type })),
    [project?.files],
  )
  const getToken = useMemo(() => {
    if (!project?.id) return async (_fileId: string) => null as string | null
    return buildFileScopedTokenFetcher(() => jwtRef.current, project.id, {
      projectName: project.name ?? undefined,
      gitlabProjectId:
        project.origin?.kind === "git" ? project.origin.gitlabProjectId : undefined,
    })
  }, [project?.id, project?.name, project?.origin])

  const { files: cellFiles } = useProjectCells({
    projectId: id ?? null,
    projectFiles,
    getToken,
    enabled: Boolean(project?.id && projectFiles.length > 0),
  })

  const concepts = useMemo(() => project?.terminology ?? [], [project])
  const hasOrigin = Boolean(project?.origin)
  const canManage = canEditTermbase(project?.syncRole, hasOrigin)

  const { active, suggested, archived } = useMemo(
    () => partitionConcepts(concepts),
    [concepts],
  )

  const [showArchived, setShowArchived] = useState(false)
  const [newSource, setNewSource] = useState("")
  const [newRendering, setNewRendering] = useState("")
  const [error, setError] = useState<string | null>(null)

  const persist = useCallback(
    async (updated: { terminology?: Concept[] }) => {
      await patchSettings({ terminology: updated.terminology ?? [] })
    },
    [patchSettings],
  )

  // ── Row callbacks (all reuse store.ts helpers over the live project) ────────
  const guard = () => {
    if (!project) return null
    if (!canManage) {
      setError("Requires Project Lead role or higher to manage the glossary.")
      return null
    }
    return project
  }

  const onEditSource = useCallback(
    (cid: string, sourceTerm: string) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { sourceTerm }))
    },
    [project, canManage, persist],
  )
  const onEditPrimary = useCallback(
    (cid: string, text: string) => {
      const p = guard()
      if (!p) return
      const concept = (p.terminology ?? []).find((c) => c.id === cid)
      if (!concept) return
      const next = setPrimaryRendering(concept, text)
      void persist(updateConcept(p, cid, { renderings: next.renderings }))
    },
    [project, canManage, persist],
  )
  const onEditRenderings = useCallback(
    (cid: string, renderings: TermRendering[]) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { renderings }))
    },
    [project, canManage, persist],
  )
  const onArchive = useCallback(
    (cid: string) => {
      const p = guard()
      if (p) void persist(updateConcept(p, cid, { status: "deprecated" }))
    },
    [project, canManage, persist],
  )
  const onRestore = useCallback(
    (cid: string) => {
      const p = guard()
      if (p) void persist(approveConcept(p, cid))
    },
    [project, canManage, persist],
  )
  const onAccept = onRestore // draft → active is the same status flip
  const onDismiss = useCallback(
    (cid: string) => {
      const p = guard()
      if (p) void persist(rejectConcept(p, cid, "delete"))
    },
    [project, canManage, persist],
  )

  const handleAddTerm = useCallback(() => {
    const p = guard()
    if (!p) return
    const source = newSource.trim()
    if (!source) return
    const renderings: TermRendering[] = newRendering.trim()
      ? [{ rendering: newRendering.trim(), status: "preferred" }]
      : []
    void persist(addConcept(p, { sourceTerm: source, renderings, status: "active" }))
    setNewSource("")
    setNewRendering("")
  }, [project, canManage, persist, newSource, newRendering])

  const handleSuggest = useCallback(() => {
    const p = guard()
    if (!p) return
    const corpus = cellFiles.flatMap((f) =>
      (f.cells ?? []).map((c: { original?: string }) => c.original ?? ""),
    )
    const candidates = extractCandidates(corpus, { managed: p.terminology ?? [] })
    const existing = new Set((p.terminology ?? []).map((c) => c.sourceTerm.trim().toLowerCase()))
    let working = p
    for (const cand of candidates) {
      if (cand.isManaged || existing.has(cand.term.trim().toLowerCase())) continue
      working = addConcept(working, { sourceTerm: cand.term, renderings: [], status: "draft" })
      existing.add(cand.term.trim().toLowerCase())
    }
    void persist(working)
  }, [project, canManage, persist, cellFiles])

  const handleImport = useCallback(
    (file: File) => {
      const p = guard()
      if (!p) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const text = String(reader.result ?? "")
          const imported = file.name.toLowerCase().endsWith(".tbx")
            ? importConceptsTbx(text)
            : importConceptsCsv(text)
          void persist({ terminology: [...(p.terminology ?? []), ...imported] })
        } catch (err) {
          setError(err instanceof Error ? err.message : "Import failed")
        }
      }
      reader.readAsText(file)
    },
    [project, canManage, persist],
  )

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading glossary…</div>
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header / toolbar */}
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <BookOpen className="h-5 w-5 text-muted-foreground" />
        <h1 className="flex-1 text-base font-semibold">Glossary</h1>
        {canManage && (
          <>
            <Button variant="outline" size="sm" onClick={handleSuggest}>
              <Sparkles className="mr-1 h-4 w-4" /> Suggest terms
            </Button>
            <label className="inline-flex">
              <input
                type="file"
                accept=".csv,.tbx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleImport(f)
                  e.target.value = ""
                }}
              />
              <Button variant="outline" size="sm" render={<span />}>
                <Upload className="mr-1 h-4 w-4" /> Import
              </Button>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadBlob(exportConceptsCsv(concepts), "glossary.csv", "text/csv")}
            >
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadBlob(exportConceptsTbx(concepts), "glossary.tbx", "application/xml")}
            >
              <Download className="mr-1 h-4 w-4" /> Export TBX
            </Button>
          </>
        )}
      </header>

      {error && (
        <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>
      )}

      {/* Column headers */}
      <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="w-4" />
        <span className="flex-1">Source</span>
        <span className="flex-1">Rendering</span>
        <span className="w-16" />
      </div>

      <main className="flex-1 overflow-y-auto">
        {/* Suggested (pending) rows */}
        {suggested.map((c) => (
          <GlossaryRow
            key={c.id}
            concept={c}
            canManage={canManage}
            onEditSource={onEditSource}
            onEditPrimary={onEditPrimary}
            onEditRenderings={onEditRenderings}
            onArchive={onArchive}
            onRestore={onRestore}
            onAccept={onAccept}
            onDismiss={onDismiss}
          />
        ))}

        {/* Active rows */}
        {active.map((c) => (
          <GlossaryRow
            key={c.id}
            concept={c}
            canManage={canManage}
            onEditSource={onEditSource}
            onEditPrimary={onEditPrimary}
            onEditRenderings={onEditRenderings}
            onArchive={onArchive}
            onRestore={onRestore}
            onAccept={onAccept}
            onDismiss={onDismiss}
          />
        ))}

        {active.length === 0 && suggested.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No terms yet. Add one below, or use “Suggest terms”.
          </p>
        )}

        {/* Append row */}
        {canManage && (
          <div className="flex items-center gap-3 border-t bg-muted/20 px-3 py-2">
            <span className="w-4" />
            <Input
              value={newSource}
              placeholder="New source term…"
              className="h-8 flex-1 text-sm"
              onChange={(e) => setNewSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTerm()}
            />
            <Input
              value={newRendering}
              placeholder="rendering"
              className="h-8 flex-1 text-sm"
              onChange={(e) => setNewRendering(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTerm()}
            />
            <Button variant="ghost" size="sm" onClick={handleAddTerm} aria-label="Add term">
              Add
            </Button>
          </div>
        )}

        {/* Archived toggle + rows */}
        {archived.length > 0 && (
          <div className="border-t">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
            </button>
            {showArchived &&
              archived.map((c) => (
                <GlossaryRow
                  key={c.id}
                  concept={c}
                  canManage={canManage}
                  onEditSource={onEditSource}
                  onEditPrimary={onEditPrimary}
                  onEditRenderings={onEditRenderings}
                  onArchive={onArchive}
                  onRestore={onRestore}
                  onAccept={onAccept}
                  onDismiss={onDismiss}
                />
              ))}
          </div>
        )}
      </main>
    </div>
  )
}
```

> **Shapes — RESOLVED (verified against the repo; use as written):**
> - `useProjectCells` — signature is `{ projectId, projectFiles: {id;name;type}[], getToken, enabled }` and it returns `{ files: { fileId; fileName; cells: CellData[] }[]; isLoading; isTruncated }`. The wiring above (jwtRef + `buildFileScopedTokenFetcher` + `projectFiles` memo) is the correct call, copied from `TerminologyPage.tsx`. `CellData.original` is the source text — the `handleSuggest` corpus mapping `cellFiles.flatMap(f => f.cells.map(c => c.original))` is correct.
> - `importConceptsCsv` / `importConceptsTbx` return `Concept[]` (confirmed in `src/lib/terminology/csv.ts:42` / `tbx.ts:112`) — the `[...existing, ...imported]` spread is correct.
> - `Button` is `@base-ui/react/button`'s `ButtonPrimitive`, which supports the `render` prop via spread props — `<Button ... render={<span />}>` inside the file-input `<label>` is valid.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/GlossaryEditor.test.tsx`
Expected: PASS (4 cases).

- [ ] **Step 5: Typecheck the new units**

Run: `pnpm build` (or `pnpm tsc -b`) — expect no new type errors in `glossary-view.ts`, `GlossaryRow.tsx`, `GlossaryEditor.tsx`. Fix any mismatches surfaced by the "Verify before relying on shapes" note.

- [ ] **Step 6: Commit**

```bash
git add src/components/GlossaryEditor.tsx src/components/GlossaryEditor.test.tsx
git commit -m "feat(terminology): GlossaryEditor — editor-like glossary surface with lifecycle + append"
```

---

### Task 4: Render `GlossaryEditor` on the terminology route

Swap the lazy `TerminologyPageContent` for `GlossaryEditor` at the terminology center-surface render site. `TerminologyPage.tsx` is left in place (not deleted) but no longer routed — its merge/violations utilities remain importable for a later follow-up.

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx` (lazy import near line 186; render site near line 3882)

**Interfaces:**
- Consumes: `GlossaryEditor` (Task 3).

- [ ] **Step 1: Add the lazy import**

Locate (near line 186):
```tsx
const TerminologyPageContent = lazy(() =>
  import("./TerminologyPage").then((mod) => ({ default: mod.TerminologyPage })),
)
```
Add directly beneath it:
```tsx
const GlossaryEditorContent = lazy(() =>
  import("./GlossaryEditor").then((mod) => ({ default: mod.GlossaryEditor })),
)
```

- [ ] **Step 2: Swap the render site**

Locate (near line 3882):
```tsx
        ) : centerSurface === "terminology" ? (
          // AQU-254: Terminology page inside the shell.
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading terminology…</div>}>
              <TerminologyPageContent />
            </Suspense>
          </div>
```
Replace `<TerminologyPageContent />` with `<GlossaryEditorContent />` (leave the surrounding div/Suspense/fallback unchanged).

- [ ] **Step 3: Verify the app builds and the route renders the editor**

Run: `pnpm build`
Expected: clean build (no unused-import error — `TerminologyPageContent` may now be unused; if the lint/build fails on that, remove the `TerminologyPageContent` lazy const in the same commit).

- [ ] **Step 4: Live check (preview)**

Start the dev stack and open a project's Glossary route (`/project/<id>/terminology`); confirm the two-column editor renders in the main area with source/rendering columns. See the `verify-dev-change` skill for the seeded-user flow.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectWorkspace.tsx
git commit -m "feat(terminology): route /terminology to GlossaryEditor surface"
```

---

### Task 5: Pinned "Glossary" pseudo-file in the file list

Add a pinned, non-`FileReference` "Glossary" entry to the top of `ExpandableFileList`, above the grouped real files. Clicking it navigates to the terminology route. Selected-state highlight matches when the route is the terminology surface.

**Files:**
- Modify: `src/components/ExpandableFileList.tsx` (add prop + pinned row in the scroll container, near line 120)
- Modify: `src/components/ProjectWorkspace.tsx` (pass the new prop where `ExpandableFileList` is rendered)
- Test: `src/components/ExpandableFileList.glossary.test.tsx`

**Interfaces:**
- Produces (new optional prop on `ExpandableFileList` `Props`):
  ```ts
  /** Render a pinned "Glossary" pseudo-file entry; invoked on click. Omit to hide. */
  onOpenGlossary?: () => void
  /** True when the glossary surface is the active center surface (for highlight). */
  glossaryActive?: boolean
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/ExpandableFileList.glossary.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ExpandableFileList } from "./ExpandableFileList"

const baseProps = {
  projectId: "p1",
  files: [],
  activeFileId: null,
  fileProgress: new Map(),
  suggestionFileIds: new Set<string>(),
  validationCount: 0,
  getTokenForFile: async () => null,
  onSelectFile: vi.fn(),
  onRename: vi.fn(),
  onMove: vi.fn(),
}

describe("ExpandableFileList glossary pseudo-file", () => {
  it("does not render a Glossary entry when onOpenGlossary is omitted", () => {
    render(<ExpandableFileList {...baseProps} />)
    expect(screen.queryByRole("button", { name: /glossary/i })).toBeNull()
  })

  it("renders a Glossary entry and fires onOpenGlossary on click", () => {
    const onOpenGlossary = vi.fn()
    render(<ExpandableFileList {...baseProps} onOpenGlossary={onOpenGlossary} />)
    fireEvent.click(screen.getByRole("button", { name: /glossary/i }))
    expect(onOpenGlossary).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/ExpandableFileList.glossary.test.tsx`
Expected: FAIL — no element with accessible name "Glossary".

- [ ] **Step 3: Add the prop and pinned row**

In `src/components/ExpandableFileList.tsx`:

1. Add to `interface Props` (after `canExportByOrgPolicy?`):
```tsx
  /** Render a pinned "Glossary" pseudo-file entry; invoked on click. Omit to hide. */
  onOpenGlossary?: () => void
  /** True when the glossary surface is the active center surface (for highlight). */
  glossaryActive?: boolean
```

2. Add `onOpenGlossary` and `glossaryActive` to the destructured params in `export function ExpandableFileList({ ... })`.

3. Import the icon at the top:
```tsx
import { Search as SearchIcon, X, ChevronDown, Pencil, BookOpen } from "lucide-react"
```

4. Inside the scroll container, as the first child of `<div className="p-2 space-y-2">` (before `{groups.length === 0 && ...}`):
```tsx
          {onOpenGlossary && (
            <button
              type="button"
              onClick={onOpenGlossary}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                glossaryActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
              )}
            >
              <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">Glossary</span>
            </button>
          )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/ExpandableFileList.glossary.test.tsx`
Expected: PASS (2 cases).

- [ ] **Step 5: Wire the prop from ProjectWorkspace**

In `src/components/ProjectWorkspace.tsx`, find the `<ExpandableFileList ... />` usage and add:
```tsx
            onOpenGlossary={() => navigate(`/project/${projectId}/terminology`)}
            glossaryActive={centerSurface === "terminology"}
```
(`navigate`, `projectId`, and `centerSurface` are already in scope in this component — confirm names match the existing render site.)

- [ ] **Step 6: Verify build + existing file-list tests still pass**

Run: `pnpm build && pnpm test src/components/ExpandableFileList`
Expected: clean build; all `ExpandableFileList*` tests pass.

- [ ] **Step 7: Live check (preview)**

In the dev stack, open a project and confirm a pinned "Glossary" row appears above the files; clicking it opens the `GlossaryEditor` surface and the row shows the active highlight.

- [ ] **Step 8: Commit**

```bash
git add src/components/ExpandableFileList.tsx src/components/ExpandableFileList.glossary.test.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(terminology): pinned Glossary pseudo-file entry routes to editor"
```

---

## Self-Review

**Spec coverage:**
- §"Data model & sync — unchanged" → Task 1/3 keep `Concept[]` + `patchSettings`. ✓
- §"Surface: GlossaryEditor" (one row per concept, primary rendering, expander, append row) → Tasks 2 (row + expander) & 3 (append row, list). ✓
- §"Lifecycle: row states" (draft pending w/ accept/dismiss, active, deprecated archive/restore, Show archived, suggestions inline) → Task 2 (affordances) + Task 3 (partition, toggle, `handleSuggest` mining → draft rows). ✓
- §"Navigation: pseudo-file entry" → Task 5. ✓
- §"Retrieval / blots / violations — reused as-is" → no task touches those modules; guaranteed by keeping the model. ✓
- §"Error handling & edge cases": optimistic writes via patchSettings ✓; incomplete drafts allowed (append allows empty rendering; only active concepts compile — unchanged) ✓; duplicate headwords — Task 3 dedups on suggest; general dedup/merge left to existing `TerminologyMergeDialog` (not re-routed — noted as follow-up). Per-term focus locks intentionally absent ✓.
- §"Testing (intent-level)": row mapping (Task 2 tests) ✓; **lifecycle→enforcement** archive assertion — Task 3 asserts persisted `status="deprecated"`; the *downstream* "drops out of compile + blots" is already covered by existing `compile.ts`/blot tests (which only consume `active`) — **added note:** the executing agent should confirm an existing test asserts non-active exclusion in `compile.test.ts`; if absent, add one asserting `compileConceptsToRules` ignores a `deprecated` concept. ✓ (gap closed via note); suggestions accept/dismiss (Task 2) ✓; pseudo-file routing (Task 5) ✓; no model regression (run full `pnpm test src/lib/terminology src/components/Terminology*` before final) ✓.

**Placeholder scan:** No TBD/TODO. "Verify before relying on shapes" notes point at exact files to confirm prop/return names — these are guardrails, not placeholders; the code given is complete and runnable pending those confirmations.

**Type consistency:** `primaryRendering`/`setPrimaryRendering`/`partitionConcepts`/`canEditTermbase` signatures identical across Tasks 1→3. `GlossaryRowProps` callback names (`onEditSource`, `onEditPrimary`, `onEditRenderings`, `onArchive`, `onRestore`, `onAccept`, `onDismiss`) identical in Tasks 2→3. `onOpenGlossary`/`glossaryActive` identical in Task 5 across `ExpandableFileList` and `ProjectWorkspace`. Concept status strings (`active`/`draft`/`deprecated`) consistent throughout.

**Known follow-ups (out of scope, flagged):** re-surfacing the violations inbox and merge dialog inside/next to the new surface; deleting the now-unrouted `TerminologyPage.tsx` once its remaining utilities are relocated.
