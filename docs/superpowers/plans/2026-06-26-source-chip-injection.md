# Source-selection AI Context Chips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a translator send a highlighted source selection into the AI agent as an inline, atomic context chip — one or many, across files — so they can ask the agent about specific phrases and how they relate.

**Architecture:** A shadcn selection toolbar (rail aesthetic) gains an "Ask AI" button that builds a client-only `ContextChip` and routes it (via `ProjectWorkspace` `pendingChip` state, mirroring the existing `pendingPrompt` flow) into a rebuilt TipTap composer. The composer holds chips as atomic inline nodes; on send it serializes the doc to one user-message string with `⟦ctx:N⟧` tokens plus a self-describing context legend. The agent reads the inline preview, or expands a chip to full text via its existing read-only SQL tool. No protocol/server change.

**Tech Stack:** React + TypeScript + Vite, TipTap 3 (already a dependency — StarterKit, `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`), shadcn/ui (`base-nova`), lucide, Vitest + Testing Library.

## Global Constraints

- **No new dependencies.** Use TipTap that is already installed (StarterKit + `@tiptap/core` + `@tiptap/react`). Do NOT add `@tiptap/extension-placeholder` — implement placeholder via `editor.isEmpty` overlay.
- **NodeView convention:** pure-DOM NodeView returning `{ dom, update, ignoreMutation }`, mirroring `src/lib/richtext/footnote-node.ts`. NOT `ReactNodeViewRenderer`.
- **No changes** to `src/lib/agent/protocol.ts`, `auth-worker/**`, `sql-guard.ts`, `schema-card.ts`, or the terminology flow. The wire stays `messages[].content: string`.
- **Source-side only** for v1 (`side: 'source'`).
- **Hybrid wire rule:** if `selection.length <= 280` the legend quotes the full selection; else a `200`-char truncated preview. Max **8** chips/message (drop extras with a `…+N more` legend line); legend capped at ~`1500` chars.
- **shadcn rules:** semantic tokens only (`bg-card`, `text-muted-foreground`), `gap-*` not `space-*`, `size-*` for square, `Badge variant="secondary"`, `AppTooltip` for hover text.
- **Preserve FRO-260/FRO-248 selection guard:** toolbar buttons call `onMouseDown` → `preventDefault()` + `onToolbarMouseDown`; `onMouseUp`/`onMouseLeave` → `onToolbarMouseUp`.
- Run a single test file with: `pnpm exec vitest run <path>`. Typecheck with `pnpm exec tsc --noEmit -p tsconfig.json`.

---

### Task 1: ContextChip model + pure serialization (`src/lib/agent/context-chip.ts`)

**Files:**
- Create: `src/lib/agent/context-chip.ts`
- Test: `src/lib/agent/context-chip.test.ts`

**Interfaces:**
- Produces:
  - `interface ContextChip { chipId: string; fileId: string; cellId: string; canonicalRef?: string; side: 'source'; selection: string; preview: string; fileName?: string }`
  - `buildSourceChip(input: { chipId: string; fileId: string; cellId: string; canonicalRef?: string; selection: string; fileName?: string }): ContextChip`
  - `serializeDocJSON(doc: { type: string; content?: unknown[] }): { text: string; chips: ContextChip[] }` — walks a TipTap JSON doc; text nodes → text, `contextChip` nodes → `⟦chip:<chipId>⟧`; blocks joined with `\n`; returns de-duped chips in first-appearance order.
  - `serializeWithChips(text: string, chips: ContextChip[]): { wire: string; display: string }`
  - constants `CHIP_PLACEHOLDER_RE = /⟦chip:([^⟧]+)⟧/g`, `FULL_INLINE_MAX = 280`, `PREVIEW_MAX = 200`, `MAX_CHIPS = 8`, `LEGEND_MAX = 1500`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent/context-chip.test.ts
import { describe, it, expect } from "vitest"
import {
  buildSourceChip,
  serializeWithChips,
  serializeDocJSON,
  type ContextChip,
} from "./context-chip"

function chip(over: Partial<ContextChip> = {}): ContextChip {
  return {
    chipId: "c1", fileId: "f-uuid", cellId: "cell-uuid",
    canonicalRef: "GEN 1:1", side: "source",
    selection: "In the beginning", preview: "In the beginning",
    ...over,
  }
}

describe("buildSourceChip", () => {
  it("caps preview but keeps full selection", () => {
    const long = "x".repeat(400)
    const c = buildSourceChip({ chipId: "c1", fileId: "f", cellId: "z", selection: long })
    expect(c.selection).toHaveLength(400)
    expect(c.preview.length).toBeLessThanOrEqual(201) // 200 + ellipsis char
    expect(c.side).toBe("source")
  })
})

describe("serializeWithChips", () => {
  it("passes text through unchanged when there are no chips", () => {
    const { wire, display } = serializeWithChips("hello world", [])
    expect(wire).toBe("hello world")
    expect(display).toBe("hello world")
  })

  it("replaces placeholders with ctx tokens (wire) and [ref] (display) and appends a legend", () => {
    const a = chip({ chipId: "a", canonicalRef: "GEN 1:1", selection: "In the beginning" })
    const b = chip({ chipId: "b", canonicalRef: "JHN 1:1", selection: "the Word", fileId: "f2", cellId: "z2" })
    const text = "compare ⟦chip:a⟧ and ⟦chip:b⟧"
    const { wire, display } = serializeWithChips(text, [a, b])
    expect(display).toBe("compare [GEN 1:1] and [JHN 1:1]")
    expect(wire).toContain("compare ⟦ctx:1⟧ and ⟦ctx:2⟧")
    expect(wire).toContain("## Context")
    expect(wire).toContain("⟦ctx:1⟧ GEN 1:1 · file_id=f-uuid cell_id=cell-uuid · source")
    expect(wire).toContain('"In the beginning"')
    expect(wire).toContain("⟦ctx:2⟧ JHN 1:1 · file_id=f2 cell_id=z2 · source")
  })

  it("inlines full text for short selections and truncates long ones in the legend", () => {
    const short = chip({ chipId: "s", selection: "short verse", preview: "short verse" })
    const long = chip({ chipId: "l", selection: "y".repeat(400), preview: "y".repeat(200) + "…" })
    const { wire } = serializeWithChips("⟦chip:s⟧ ⟦chip:l⟧", [short, long])
    expect(wire).toContain('"short verse"')
    expect(wire).toContain("y".repeat(200) + "…")
    expect(wire).not.toContain("y".repeat(400))
  })

  it("caps chip count at 8 and notes the overflow", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      chip({ chipId: `c${i}`, canonicalRef: `REF ${i}` }))
    const text = many.map((c) => `⟦chip:${c.chipId}⟧`).join(" ")
    const { wire } = serializeWithChips(text, many)
    expect(wire).toContain("⟦ctx:8⟧")
    expect(wire).not.toContain("⟦ctx:9⟧")
    expect(wire).toContain("…+3 more")
  })
})

describe("serializeDocJSON", () => {
  it("interleaves text and chip placeholders in order and de-dupes", () => {
    const a = chip({ chipId: "a" })
    const doc = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "look at " },
          { type: "contextChip", attrs: a },
          { type: "text", text: " here " },
          { type: "contextChip", attrs: a }, // duplicate node, same chip
        ],
      }],
    }
    const { text, chips } = serializeDocJSON(doc)
    expect(text).toBe("look at ⟦chip:a⟧ here ⟦chip:a⟧")
    expect(chips).toHaveLength(1)
    expect(chips[0].chipId).toBe("a")
  })

  it("joins multiple paragraphs with newlines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "line one" }] },
        { type: "paragraph", content: [{ type: "text", text: "line two" }] },
      ],
    }
    expect(serializeDocJSON(doc).text).toBe("line one\nline two")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/agent/context-chip.test.ts`
Expected: FAIL — `Cannot find module './context-chip'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent/context-chip.ts
/**
 * Client-only model + serialization for AI-chat context chips.
 *
 * A ContextChip is a highlighted SOURCE selection the user attached to an
 * agent message. Chips live in the TipTap composer as atomic nodes; at send
 * time the doc is serialized to ONE user-message string: prose with inline
 * ⟦ctx:N⟧ tokens plus a self-describing "Context" legend. The agent reads the
 * truncated preview inline, or expands a chip to full text via its existing
 * read-only SQL tool keyed by file_id/cell_id. No protocol/server change.
 */

export interface ContextChip {
  chipId: string
  fileId: string
  cellId: string
  canonicalRef?: string
  side: "source"
  selection: string
  preview: string
  fileName?: string
}

export const CHIP_PLACEHOLDER_RE = /⟦chip:([^⟧]+)⟧/g
export const FULL_INLINE_MAX = 280
export const PREVIEW_MAX = 200
export const MAX_CHIPS = 8
export const LEGEND_MAX = 1500

function capPreview(selection: string): string {
  const s = selection.replace(/\s+/g, " ").trim()
  return s.length <= PREVIEW_MAX ? s : s.slice(0, PREVIEW_MAX) + "…"
}

export function buildSourceChip(input: {
  chipId: string
  fileId: string
  cellId: string
  canonicalRef?: string
  selection: string
  fileName?: string
}): ContextChip {
  return {
    chipId: input.chipId,
    fileId: input.fileId,
    cellId: input.cellId,
    canonicalRef: input.canonicalRef,
    side: "source",
    selection: input.selection,
    preview: capPreview(input.selection),
    fileName: input.fileName,
  }
}

interface JsonNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
}

export function serializeDocJSON(doc: { type?: string; content?: unknown[] }): {
  text: string
  chips: ContextChip[]
} {
  const blocks: string[] = []
  const chips: ContextChip[] = []
  const seen = new Set<string>()

  const walkInline = (nodes: JsonNode[] | undefined): string => {
    if (!nodes) return ""
    let out = ""
    for (const n of nodes) {
      if (n.type === "contextChip" && n.attrs) {
        const chip = n.attrs as unknown as ContextChip
        out += `⟦chip:${chip.chipId}⟧`
        if (!seen.has(chip.chipId)) {
          seen.add(chip.chipId)
          chips.push(chip)
        }
      } else if (n.type === "text" && typeof n.text === "string") {
        out += n.text
      } else if (n.content) {
        out += walkInline(n.content)
      }
    }
    return out
  }

  for (const block of (doc.content as JsonNode[] | undefined) ?? []) {
    blocks.push(walkInline(block.content))
  }
  return { text: blocks.join("\n"), chips }
}

export function serializeWithChips(
  text: string,
  chips: ContextChip[],
): { wire: string; display: string } {
  if (chips.length === 0) return { wire: text, display: text }

  const kept = chips.slice(0, MAX_CHIPS)
  const overflow = chips.length - kept.length
  const indexById = new Map(kept.map((c, i) => [c.chipId, i + 1]))

  const replace = (render: (chip: ContextChip, n: number) => string) =>
    text.replace(CHIP_PLACEHOLDER_RE, (_m, id: string) => {
      const n = indexById.get(id)
      const chip = kept.find((c) => c.chipId === id)
      // Dropped (overflow) or unknown chip: leave a readable marker.
      if (!n || !chip) return chip?.canonicalRef ? `[${chip.canonicalRef}]` : ""
      return render(chip, n)
    })

  const wireText = replace((_c, n) => `⟦ctx:${n}⟧`)
  const display = replace((c) => `[${c.canonicalRef ?? "source"}]`)

  const lines: string[] = [
    "## Context (attached cells — previews truncated; read full text with one SQL query on file_id+cell_id if needed)",
  ]
  for (const c of kept) {
    const n = indexById.get(c.chipId)!
    const quoted = c.selection.length <= FULL_INLINE_MAX ? c.selection : c.preview
    lines.push(`⟦ctx:${n}⟧ ${c.canonicalRef ?? "source"} · file_id=${c.fileId} cell_id=${c.cellId} · source`)
    lines.push(`   "${quoted}"`)
  }
  if (overflow > 0) lines.push(`…+${overflow} more`)

  let legend = lines.join("\n")
  if (legend.length > LEGEND_MAX) legend = legend.slice(0, LEGEND_MAX) + "\n…"

  return { wire: `${wireText}\n\n${legend}`, display }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/agent/context-chip.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/context-chip.ts src/lib/agent/context-chip.test.ts
git commit -m "feat(agent): context-chip model + serialization"
```

---

### Task 2: `SourceSelectionToolbar` component (shadcn, rail aesthetic)

**Files:**
- Create: `src/components/SourceSelectionToolbar.tsx`
- Test: `src/components/SourceSelectionToolbar.test.tsx`

**Interfaces:**
- Consumes: `Concept` type (from the terminology types already imported in `EditorTable.tsx`), `TermLookupPopover` (existing).
- Produces:
  - `interface SourceSelectionToolbarProps { sourceSelection: string; concepts: Concept[]; onAskAi: () => void; onAddToTermbase?: () => void; onTermApply: (rendering: string) => void; onToolbarMouseDown?: () => void; onToolbarMouseUp?: () => void }`
  - `function SourceSelectionToolbar(props): JSX.Element`

**Note:** This replaces the inline `SelectionTermActions` markup in `EditorTable.tsx` (lines ~1591–1676). Move the existing `hasMatch`/`activeConcepts` logic and the `TermLookupPopover` "View term" branch into this file verbatim; add the new "Ask AI" button. Keep the FRO-260 `handleButtonMouseDown` (`preventDefault` + `onToolbarMouseDown`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/SourceSelectionToolbar.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"

const noConcepts = { concepts: [], onTermApply: vi.fn() }

describe("SourceSelectionToolbar", () => {
  it("renders Ask AI and Add to terms with labels", () => {
    render(
      <SourceSelectionToolbar
        sourceSelection="grace"
        onAskAi={vi.fn()}
        onAddToTermbase={vi.fn()}
        {...noConcepts}
      />,
    )
    expect(screen.getByRole("button", { name: /ask ai/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /add to terms/i })).toBeInTheDocument()
  })

  it("fires onAskAi on click", () => {
    const onAskAi = vi.fn()
    render(
      <SourceSelectionToolbar sourceSelection="grace" onAskAi={onAskAi} onAddToTermbase={vi.fn()} {...noConcepts} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /ask ai/i }))
    expect(onAskAi).toHaveBeenCalledOnce()
  })

  it("hides Add to terms when no callback is wired but always shows Ask AI", () => {
    render(<SourceSelectionToolbar sourceSelection="grace" onAskAi={vi.fn()} {...noConcepts} />)
    expect(screen.queryByRole("button", { name: /add to terms/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /ask ai/i })).toBeInTheDocument()
  })

  it("calls the selection guard on button mousedown", () => {
    const onToolbarMouseDown = vi.fn()
    render(
      <SourceSelectionToolbar
        sourceSelection="grace" onAskAi={vi.fn()} onAddToTermbase={vi.fn()}
        onToolbarMouseDown={onToolbarMouseDown} {...noConcepts}
      />,
    )
    fireEvent.mouseDown(screen.getByRole("button", { name: /ask ai/i }))
    expect(onToolbarMouseDown).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/components/SourceSelectionToolbar.test.tsx`
Expected: FAIL — `Cannot find module './SourceSelectionToolbar'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/SourceSelectionToolbar.tsx
// Floating action cluster shown above a SOURCE selection. Mirrors the
// CellActionRail aesthetic (rounded, neumorphic pill, muted icons, AppTooltip).
// Buttons: Ask AI (push selection into the agent chat as a chip) and Add to
// terms (existing terminology flow). A "View term" lookup appears when the
// selection matches an active concept.
import { useMemo } from "react"
import { BookOpen, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import type { Concept } from "@/lib/terminology/types"
import { TermLookupPopover } from "./TermLookupPopover"

export interface SourceSelectionToolbarProps {
  sourceSelection: string
  concepts: Concept[]
  onAskAi: () => void
  onAddToTermbase?: () => void
  onTermApply: (rendering: string) => void
  /** FRO-260: called on mousedown so the parent suppresses selectionchange clearing. */
  onToolbarMouseDown?: () => void
  /** FRO-260: called on mouseup/mouseleave so the parent resets the guard. */
  onToolbarMouseUp?: () => void
}

const PILL =
  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium " +
  "text-muted-foreground/80 transition-[transform,color,background-color] duration-150 " +
  "hover:bg-muted/80 hover:text-foreground active:scale-[0.92] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"

export function SourceSelectionToolbar({
  sourceSelection,
  concepts,
  onAskAi,
  onAddToTermbase,
  onTermApply,
  onToolbarMouseDown,
  onToolbarMouseUp,
}: SourceSelectionToolbarProps) {
  const activeConcepts = useMemo(() => concepts.filter((c) => c.status === "active"), [concepts])
  const hasMatch = useMemo(
    () =>
      activeConcepts.some(
        (c) =>
          c.sourceTerm.toLowerCase().includes(sourceSelection.toLowerCase()) ||
          sourceSelection.toLowerCase().includes(c.sourceTerm.toLowerCase()),
      ),
    [activeConcepts, sourceSelection],
  )

  // FRO-260: preserve the browser selection + suppress the selectionchange guard.
  const handleButtonMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    onToolbarMouseDown?.()
  }

  return (
    <div
      className="absolute right-1 top-0 z-10 flex items-center gap-0.5 rounded-full bg-card px-1 py-0.5 shadow-neu-sm"
      dir="ltr"
      onMouseUp={onToolbarMouseUp}
      onMouseLeave={onToolbarMouseUp}
    >
      {hasMatch && (
        <TermLookupPopover sourceTerm={sourceSelection} concepts={activeConcepts} onApply={onTermApply}>
          <AppTooltip content="View matching term">
            <button type="button" onMouseDown={handleButtonMouseDown} className={cn(PILL)}>
              <BookOpen className="size-3" aria-hidden />
              View term
            </button>
          </AppTooltip>
        </TermLookupPopover>
      )}

      <AppTooltip content="Ask the AI agent about this selection">
        <button type="button" onMouseDown={handleButtonMouseDown} onClick={onAskAi} className={cn(PILL)}>
          <Sparkles className="size-3" aria-hidden />
          Ask AI
        </button>
      </AppTooltip>

      {onAddToTermbase && (
        <AppTooltip content="Add this selection to the term base">
          <button type="button" onMouseDown={handleButtonMouseDown} onClick={onAddToTermbase} className={cn(PILL)}>
            <BookOpen className="size-3" aria-hidden />
            Add to terms
          </button>
        </AppTooltip>
      )}
    </div>
  )
}
```

> Implementer note: confirm the `Concept` import path used by `EditorTable.tsx` (search `import .* Concept`) and match it exactly here; the path above (`@/lib/terminology/types`) is the expected location — adjust if the repo differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/components/SourceSelectionToolbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/SourceSelectionToolbar.tsx src/components/SourceSelectionToolbar.test.tsx
git commit -m "feat(editor): shadcn source-selection toolbar with Ask AI"
```

---

### Task 3: Wire the toolbar + chip building into `EditorTable`

**Files:**
- Modify: `src/components/EditorTable.tsx` (remove `SelectionTermActions` def ~1591–1676; swap render site ~3195–3203; add `onAskAiFromSelection` prop + handler)
- Test: extend `src/lib/agent/context-chip.test.ts` (the chip-building is pure — covered there)

**Interfaces:**
- Consumes: `buildSourceChip` (Task 1), `SourceSelectionToolbar` (Task 2).
- Produces: new `EditorTable`/`EditorRow` prop `onAskAiFromSelection?: (chip: ContextChip) => void`.

- [ ] **Step 1: Add a chip-building test (extends Task 1 test file)**

```ts
// append to src/lib/agent/context-chip.test.ts
import { buildSourceChip } from "./context-chip"

describe("buildSourceChip from a cell", () => {
  it("captures coordinates and canonical ref", () => {
    const c = buildSourceChip({
      chipId: "x", fileId: "file-1", cellId: "cell-9",
      canonicalRef: "GEN 1:1", selection: "In the beginning",
    })
    expect(c).toMatchObject({ fileId: "file-1", cellId: "cell-9", canonicalRef: "GEN 1:1", side: "source" })
  })
})
```

- [ ] **Step 2: Run it (should already pass from Task 1)**

Run: `pnpm exec vitest run src/lib/agent/context-chip.test.ts`
Expected: PASS.

- [ ] **Step 3: Delete the old `SelectionTermActions` component**

Remove the `SelectionTermActionsProps` interface and `function SelectionTermActions(...)` (EditorTable.tsx ~1591–1676). Add at the top of `EditorTable.tsx` imports:

```tsx
import { SourceSelectionToolbar } from "./SourceSelectionToolbar"
import { buildSourceChip, type ContextChip } from "@/lib/agent/context-chip"
```

- [ ] **Step 4: Add the prop + handler**

Add to the `EditorTable` props interface (next to `onAddConceptFromSelection`):

```tsx
/** Push the current source selection into the AI agent as a context chip. */
onAskAiFromSelection?: (chip: ContextChip) => void
```

Thread `onAskAiFromSelection` to `EditorRow` (same path as `onAddConceptFromSelection`). In `EditorRow`, add the handler (near `handleAddSelectionToTermbase`):

```tsx
const handleAskAiFromSelection = useCallback(() => {
  const text = capturedSelectionRef.current
  if (!text || !onAskAiFromSelection) return
  const chip = buildSourceChip({
    chipId: `chip-${cell.fileId}-${cell.id}-${Date.now().toString(36)}`,
    fileId: cell.fileId,
    cellId: cell.id,
    canonicalRef: cell.context ?? cell.group ?? undefined,
    selection: text,
  })
  onAskAiFromSelection(chip)
  // Clear like the terminology path so the toolbar dismisses.
  capturedSelectionRef.current = null
  setSourceSelection(null)
  window.getSelection()?.removeAllRanges()
}, [onAskAiFromSelection, cell.fileId, cell.id, cell.context, cell.group])
```

- [ ] **Step 5: Swap the render site**

Replace the `<SelectionTermActions … />` block (~3195–3203) with:

```tsx
{sourceSelection && (
  <SourceSelectionToolbar
    sourceSelection={sourceSelection}
    concepts={project.terminology ?? []}
    onAskAi={handleAskAiFromSelection}
    onAddToTermbase={onAddConceptFromSelection ? handleAddSelectionToTermbase : undefined}
    onTermApply={handleTermApply}
    onToolbarMouseDown={handleToolbarMouseDown}
    onToolbarMouseUp={handleToolbarMouseUp}
  />
)}
```

Also change the source container's `onMouseUp` guard so the toolbar shows when EITHER callback is wired:

```tsx
onMouseUp={(onAddConceptFromSelection || onAskAiFromSelection) ? handleSourceMouseUp : undefined}
```

And relax the `handleSourceMouseUp` early-return:

```tsx
if (!onAddConceptFromSelection && !onAskAiFromSelection) return
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

```bash
git add src/components/EditorTable.tsx src/lib/agent/context-chip.test.ts
git commit -m "feat(editor): route source selection to Ask AI chip"
```

---

### Task 4: TipTap `contextChip` atomic node (`src/lib/richtext/context-chip-node.ts`)

**Files:**
- Create: `src/lib/richtext/context-chip-node.ts`
- Test: `src/lib/richtext/context-chip-node.test.ts`

**Interfaces:**
- Consumes: `ContextChip` (Task 1).
- Produces: `export const ContextChipNode` (TipTap `Node`), name `"contextChip"`, inline atom; attrs mirror `ContextChip`; `renderText` → `⟦chip:<chipId>⟧`; pure-DOM NodeView renders a `Badge`-styled pill (label = `canonicalRef ?? "source"`, native `title` = full selection) with a `×` delete button.

- [ ] **Step 1: Write the failing test (headless editor → getText)**

```ts
// src/lib/richtext/context-chip-node.test.ts
import { describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { ContextChipNode } from "./context-chip-node"

function makeEditor() {
  return new Editor({
    extensions: [StarterKit.configure({ heading: false }), ContextChipNode],
    content: {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          { type: "contextChip", attrs: {
            chipId: "a", fileId: "f", cellId: "z", canonicalRef: "GEN 1:1",
            side: "source", selection: "In the beginning", preview: "In the beginning",
          } },
        ],
      }],
    },
  })
}

describe("ContextChipNode", () => {
  it("renderText emits a stable chip placeholder", () => {
    const editor = makeEditor()
    expect(editor.getText()).toBe("see ⟦chip:a⟧")
    editor.destroy()
  })

  it("round-trips through getJSON with attrs intact", () => {
    const editor = makeEditor()
    const json = editor.getJSON()
    const para = json.content![0]
    const chipNode = para.content!.find((n: { type?: string }) => n.type === "contextChip")
    expect(chipNode!.attrs).toMatchObject({ chipId: "a", canonicalRef: "GEN 1:1", fileId: "f", cellId: "z" })
    editor.destroy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/richtext/context-chip-node.test.ts`
Expected: FAIL — `Cannot find module './context-chip-node'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/richtext/context-chip-node.ts
// Atomic inline node for an AI-chat context chip. Pure-DOM NodeView (mirrors
// footnote-node.ts): renders a compact Badge-styled pill showing the canonical
// ref, with the full selection as a native hover tooltip and an × to delete.
// renderText emits ⟦chip:<chipId>⟧ so the serializer can map it to a ctx token.
import { Node, mergeAttributes } from "@tiptap/core"

export const CONTEXT_CHIP_NODE_NAME = "contextChip"

const ATTR_KEYS = ["chipId", "fileId", "cellId", "canonicalRef", "side", "selection", "preview", "fileName"] as const

export const ContextChipNode = Node.create({
  name: CONTEXT_CHIP_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    const attrs: Record<string, { default: unknown }> = {}
    for (const key of ATTR_KEYS) attrs[key] = { default: key === "side" ? "source" : "" }
    return attrs
  },

  parseHTML() {
    return [{ tag: "span[data-context-chip]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    // Serialize attrs into data-* so getHTML round-trips (not used on the wire).
    const data: Record<string, string> = { "data-context-chip": "" }
    for (const key of ATTR_KEYS) data[`data-${key.toLowerCase()}`] = String(node.attrs[key] ?? "")
    return ["span", mergeAttributes(HTMLAttributes, data, { class: "context-chip" }), node.attrs.canonicalRef || "source"]
  },

  renderText({ node }) {
    return `⟦chip:${node.attrs.chipId as string}⟧`
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("span")
      // Match Badge variant="secondary": rounded pill, muted surface.
      dom.className =
        "context-chip inline-flex items-center gap-1 rounded-md border border-transparent " +
        "bg-muted px-1.5 py-0.5 align-baseline text-xs font-medium text-muted-foreground"
      dom.setAttribute("contenteditable", "false")
      const label = (node.attrs.canonicalRef as string) || "source"
      dom.title = (node.attrs.selection as string) || label // native hover tooltip
      dom.setAttribute("data-tooltip", (node.attrs.selection as string) || label) // test hook

      const text = document.createElement("span")
      text.textContent = label
      dom.append(text)

      const close = document.createElement("button")
      close.type = "button"
      close.setAttribute("aria-label", `Remove ${label}`)
      close.className = "ml-0.5 rounded-sm text-muted-foreground/60 hover:text-foreground"
      close.textContent = "×"
      close.addEventListener("mousedown", (e) => e.preventDefault())
      close.addEventListener("click", (e) => {
        e.preventDefault()
        if (typeof getPos !== "function") return
        const from = getPos()
        editor.chain().focus().deleteRange({ from, to: from + node.nodeSize }).run()
      })
      dom.append(close)

      return { dom, ignoreMutation: () => true }
    }
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/richtext/context-chip-node.test.ts`
Expected: PASS. (If the headless `Editor` cannot construct under the test DOM, fall back to asserting `serializeDocJSON` on a hand-built JSON doc — already covered in Task 1 — and verify the node live in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/richtext/context-chip-node.ts src/lib/richtext/context-chip-node.test.ts
git commit -m "feat(richtext): contextChip atomic node"
```

---

### Task 5: Rebuild `ChatComposer` on TipTap with chip support

**Files:**
- Modify: `src/components/chat/ChatComposer.tsx`
- Test: `src/components/chat/ChatComposer.test.tsx`

**Interfaces:**
- Consumes: `ContextChipNode` (Task 4), `serializeDocJSON` + `ContextChip` (Task 1).
- Produces (CHANGED): `onSend` now delivers a payload, and the component is `forwardRef` exposing an imperative handle:
  - `interface ChatComposerHandle { insertChip: (chip: ContextChip) => void }`
  - `onSend: (payload: { text: string; chips: ContextChip[] }) => void`
  - Other props unchanged (`isStreaming`, `isConfigured`, `onStop`, `compact`, `suggestedActions`).

**Note:** `AgentDockView` is the only consumer (chat was removed). Update it in Task 6.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/chat/ChatComposer.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { createRef } from "react"
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer"

describe("ChatComposer (TipTap)", () => {
  it("sends typed text with an empty chip list on Enter", async () => {
    const onSend = vi.fn()
    render(<ChatComposer isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    const box = screen.getByRole("textbox")
    fireEvent.focus(box)
    // TipTap edits the contenteditable; type via the editor DOM.
    box.textContent = "hello agent"
    fireEvent.input(box)
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("hello agent"), chips: [] }))
  })

  it("insertChip adds a chip that serializes into the send payload", () => {
    const onSend = vi.fn()
    const ref = createRef<ChatComposerHandle>()
    render(<ChatComposer ref={ref} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    ref.current!.insertChip({
      chipId: "a", fileId: "f", cellId: "z", canonicalRef: "GEN 1:1",
      side: "source", selection: "In the beginning", preview: "In the beginning",
    })
    const box = screen.getByRole("textbox")
    fireEvent.keyDown(box, { key: "Enter" })
    const payload = onSend.mock.calls[0][0]
    expect(payload.chips).toHaveLength(1)
    expect(payload.text).toContain("⟦chip:a⟧")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/components/chat/ChatComposer.test.tsx`
Expected: FAIL — `ChatComposer` is not a forwardRef / `insertChip` undefined / payload shape mismatch.

- [ ] **Step 3: Write the implementation**

Replace `ChatComposer.tsx` with a TipTap editor. Keep the InputGroup-style shell, suggested actions, and send/stop controls; swap the `<InputGroupTextarea>` for `<EditorContent>`.

```tsx
// src/components/chat/ChatComposer.tsx
import {
  forwardRef, useEffect, useImperativeHandle, useState,
} from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { ArrowUp, Sparkles, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup, InputGroupAddon, InputGroupButton, InputGroupText,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import { ContextChipNode } from "@/lib/richtext/context-chip-node"
import { serializeDocJSON, type ContextChip } from "@/lib/agent/context-chip"

export interface SuggestedAction {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}

export interface ChatComposerHandle {
  insertChip: (chip: ContextChip) => void
}

export interface ChatComposerProps {
  isStreaming: boolean
  isConfigured: boolean
  onSend: (payload: { text: string; chips: ContextChip[] }) => void
  onStop: () => void
  compact?: boolean
  suggestedActions?: SuggestedAction[]
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { isStreaming, isConfigured, onSend, onStop, compact, suggestedActions },
  ref,
) {
  const [isEmpty, setIsEmpty] = useState(true)

  const editor = useEditor({
    editable: isConfigured,
    extensions: [
      StarterKit.configure({
        heading: false, bulletList: false, orderedList: false, listItem: false,
        blockquote: false, codeBlock: false, horizontalRule: false,
      }),
      ContextChipNode,
    ],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Ask the agent",
        class: cn(
          "max-h-32 min-h-9 overflow-y-auto px-3 py-2 focus:outline-none",
          compact ? "text-xs" : "text-sm",
        ),
      },
      handleKeyDown(_view, event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault()
          handleSend()
          return true
        }
        return false
      },
    },
    onUpdate({ editor }) {
      setIsEmpty(editor.isEmpty)
    },
  })

  // Re-focus on mount once configured.
  useEffect(() => {
    if (editor && isConfigured) editor.commands.focus()
  }, [editor, isConfigured])

  function handleSend() {
    if (!editor || isStreaming || !isConfigured) return
    const { text, chips } = serializeDocJSON(editor.getJSON())
    if (!text.trim() && chips.length === 0) return
    onSend({ text, chips })
    editor.commands.clearContent()
    setIsEmpty(true)
  }

  useImperativeHandle(ref, () => ({
    insertChip(chip: ContextChip) {
      if (!editor) return
      // De-dupe on (fileId, cellId, selection): skip if an identical chip exists.
      let exists = false
      editor.state.doc.descendants((node) => {
        if (
          node.type.name === "contextChip" &&
          node.attrs.fileId === chip.fileId &&
          node.attrs.cellId === chip.cellId &&
          node.attrs.selection === chip.selection
        ) exists = true
      })
      if (exists) { editor.commands.focus(); return }
      editor
        .chain()
        .focus()
        .insertContent([{ type: "contextChip", attrs: chip }, { type: "text", text: " " }])
        .run()
      setIsEmpty(editor.isEmpty)
    },
  }), [editor])

  return (
    <div className={cn("border-t", compact ? "p-2" : "p-3")}>
      <div className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2")}>
        {suggestedActions && suggestedActions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {suggestedActions.map((action) => (
              <Button
                key={action.label}
                type="button"
                variant="outline"
                size="sm"
                disabled={action.disabled || !isConfigured || isStreaming}
                title={action.title}
                onClick={action.onClick}
                className={cn(compact ? "h-6 text-[10px]" : "h-7 text-xs")}
              >
                <Sparkles data-icon="inline-start" />
                {action.label}
              </Button>
            ))}
          </div>
        )}
        <InputGroup>
          <div className="relative flex-1">
            <EditorContent editor={editor} />
            {isEmpty && (
              <span className="pointer-events-none absolute left-3 top-2 text-muted-foreground" aria-hidden>
                Ask the agent…
              </span>
            )}
          </div>
          <InputGroupAddon align="block-end">
            <InputGroupText className={cn(compact ? "text-[9px]" : "text-[10px]")}>
              Enter to send · Shift+Enter for newline
            </InputGroupText>
            {isStreaming ? (
              <InputGroupButton type="button" variant="outline" size="icon-sm" onClick={onStop} className="ml-auto" aria-label="Stop" title="Stop">
                <Square />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="button" variant="default" size="icon-sm" onClick={handleSend} disabled={(isEmpty) || !isConfigured} className="ml-auto" aria-label="Send" title="Send">
                <ArrowUp />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  )
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/components/chat/ChatComposer.test.tsx`
Expected: PASS. (If TipTap contenteditable input is not exercised faithfully under the test DOM, keep the `insertChip` test as the primary guarantee and validate plain-typing send live in Task 8. Do NOT delete the typed-text test — adjust the input dispatch to match the editor.)

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

```bash
git add src/components/chat/ChatComposer.tsx src/components/chat/ChatComposer.test.tsx
git commit -m "feat(agent): TipTap chip-aware composer"
```

---

### Task 6: `AgentDockView` — consume payload, serialize wire, accept pendingChip

**Files:**
- Modify: `src/components/agent/AgentDockView.tsx`
- Modify: `src/lib/agent/run-state.ts` (add optional `wireContent` to `AgentRunUi` + `createRun`)
- Test: `src/lib/agent/run-state.test.ts` (if present) — otherwise covered by Task 1 + live

**Interfaces:**
- Consumes: `ChatComposer` (forwardRef + payload, Task 5), `serializeWithChips` + `ContextChip` (Task 1).
- Produces: new `AgentDockView` props `pendingChip?: ContextChip | null` and `onPendingChipConsumed?: () => void`.

- [ ] **Step 1: Extend `createRun` to carry wire content**

In `src/lib/agent/run-state.ts`, add `wireContent?: string` to the `AgentRunUi` interface, and update `createRun`:

```ts
export function createRun(prompt: string, wireContent?: string): AgentRunUi {
  return {
    // ...existing fields...
    prompt,
    wireContent: wireContent ?? prompt,
  }
}
```

(Leave all other fields untouched. If `createRun` has existing call sites/tests, `wireContent` is optional and defaults to `prompt`, so they are unaffected.)

- [ ] **Step 2: Update `sendPrompt` + composer wiring**

In `AgentDockView.tsx`:

Add imports:

```tsx
import { useRef } from "react"
import { ChatComposer, type ChatComposerHandle, type SuggestedAction } from "@/components/chat/ChatComposer"
import { serializeWithChips, type ContextChip } from "@/lib/agent/context-chip"
```

Add the two props to `AgentDockViewProps`:

```tsx
/** A chip to insert into the composer as soon as the view is ready. */
pendingChip?: ContextChip | null
/** Called once the pending chip has been inserted, so the parent clears it. */
onPendingChipConsumed?: () => void
```

Add a composer ref and change `sendPrompt` to accept chips and build the wire:

```tsx
const composerRef = useRef<ChatComposerHandle>(null)

const sendPrompt = useCallback(
  async (text: string, chips: ContextChip[] = []) => {
    const trimmed = text.trim()
    if ((!trimmed && chips.length === 0) || !jwt || isStreaming) return
    const { wire, display } = serializeWithChips(text, chips)

    const run = createRun(display, wire)
    setRuns((prev) => [...prev, run])
    setIsStreaming(true)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const messages: { role: "user" | "assistant"; content: string }[] = []
    for (const r of runs) {
      messages.push({ role: "user", content: r.wireContent ?? r.prompt })
      if (r.assistantText) messages.push({ role: "assistant", content: r.assistantText })
    }
    messages.push({ role: "user", content: wire })
    const truncated = messages.slice(-MAX_WIRE_TURNS)
    // ...rest of the existing runAgent(...) body unchanged...
  },
  [jwt, isStreaming, runs, projectId, includeContext, context, updateRun],
)
```

(Keep the rest of the function body — `runAgent`, frame handling, error handling — exactly as-is.)

Update the `pendingPrompt` effect to call `sendPrompt(pendingPrompt)` (now 1-arg path still valid), and add a `pendingChip` effect:

```tsx
// Insert a chip handed in from the editor's "Ask AI" selection action.
useEffect(() => {
  if (!pendingChip) return
  composerRef.current?.insertChip(pendingChip)
  onPendingChipConsumed?.()
}, [pendingChip, onPendingChipConsumed])
```

Update the `<ChatComposer>` render to pass the ref and the payload-shaped `onSend`:

```tsx
<ChatComposer
  ref={composerRef}
  isStreaming={isStreaming}
  isConfigured={Boolean(jwt)}
  onSend={({ text, chips }) => void sendPrompt(text, chips)}
  onStop={stop}
  compact
  suggestedActions={suggestedActions}
/>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 4: Run the agent test suites**

Run: `pnpm exec vitest run src/components/agent/AgentRunView.test.tsx src/lib/agent/context-chip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/agent/AgentDockView.tsx src/lib/agent/run-state.ts
git commit -m "feat(agent): serialize chips to wire + accept pendingChip"
```

---

### Task 7: `AgentDockPanel` + `ProjectWorkspace` wiring

**Files:**
- Modify: `src/components/AgentDockPanel.tsx` (pass `pendingChip`/`onPendingChipConsumed` through)
- Modify: `src/components/ProjectWorkspace.tsx` (`pendingChip` state, `handleAskAiFromSelection`, `setDockTab('agent')`, pass to `EditorTable` + `AgentDockPanel`)

**Interfaces:**
- Consumes: `ContextChip` (Task 1); `AgentDockView` `pendingChip` props (Task 6); `EditorTable` `onAskAiFromSelection` (Task 3).

- [ ] **Step 1: Thread through `AgentDockPanel`**

Add to `AgentDockPanelProps`:

```tsx
pendingChip?: ContextChip | null
onPendingChipConsumed?: () => void
```

Pass them to `<AgentDockView … pendingChip={pendingChip} onPendingChipConsumed={onPendingChipConsumed} />`. Import `type ContextChip` from `@/lib/agent/context-chip`.

- [ ] **Step 2: Add state + handler in `ProjectWorkspace`**

Near the other dock state (`const [dockTab, setDockTab] = useState…`):

```tsx
const [pendingChip, setPendingChip] = useState<ContextChip | null>(null)

const handleAskAiFromSelection = useCallback((chip: ContextChip) => {
  setPendingChip(chip)
  setDockTab("agent") // open/switch the dock to the Agent tab (LeftDock is externally controlled)
}, [])
```

Import `type ContextChip` from `@/lib/agent/context-chip`.

- [ ] **Step 3: Pass to `EditorTable` and `AgentDockPanel`**

On `<EditorTable … />` add:

```tsx
onAskAiFromSelection={handleAskAiFromSelection}
```

On `<AgentDockPanel … />` add:

```tsx
pendingChip={pendingChip}
onPendingChipConsumed={() => setPendingChip(null)}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/AgentDockPanel.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(agent): wire source Ask AI into the agent dock"
```

---

### Task 8: Full verification (types, tests, live UI)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 2: Run the new + adjacent suites**

Run: `pnpm exec vitest run src/lib/agent/context-chip.test.ts src/lib/richtext/context-chip-node.test.ts src/components/SourceSelectionToolbar.test.tsx src/components/chat/ChatComposer.test.tsx src/components/agent/AgentRunView.test.tsx`
Expected: all PASS.

- [ ] **Step 3: Live verification (verify-dev-change skill)**

Boot the dev stack; log in via `/__dev/login`; the dev seed has no files, so import or open a project that has a source file with cells (or extend `dev-seed.ts` with a small scripture file). Then:
1. Select source text in a cell → confirm the new toolbar appears with **Ask AI** + **Add to terms** (rail aesthetic).
2. Click **Ask AI** → the dock switches to the Agent tab and a chip pill (canonical ref) appears in the composer; hover shows the full selection.
3. Repeat from another cell/file → a second pill.
4. Type around the pills and send → the user bubble shows `[GEN 1:1] … [JHN 1:1]`; inspect the outgoing request (preview_network or console) to confirm the message `content` carries `⟦ctx:1⟧/⟦ctx:2⟧` + the `## Context` legend with `file_id`/`cell_id`.
5. Confirm **Add to terms** still opens the AddConcept dialog unchanged.

Capture a screenshot of the composer with two chips as evidence.

- [ ] **Step 4: Commit any fixes found during live verification**

```bash
git add -A
git commit -m "fix(agent): address live-verification findings for context chips"
```

---

## Self-Review

**Spec coverage:**
- §3 toolbar + Ask AI → Tasks 2, 3. §4 ContextChip → Task 1. §5 shadcn toolbar → Task 2. §6 TipTap composer + chip node → Tasks 4, 5. §7 wire injection (tokens + legend + hybrid) → Task 1 (`serializeWithChips`). §8 agent expansion → no code (existing SQL; verified by the legend format in Task 1 + live §3.4). §9 L1/L2/L3 → satisfied by "no protocol/schema change" constraint (Tasks 6/7 keep `content: string`). §10 defaults/limits → Task 1 constants. §11 files → Tasks 1–7. §12 testing → Tasks 1,2,4,5,8. §13 out-of-scope → not implemented (correct). §14 risks → Task 5 fallback notes, Task 3 selection-guard preservation, Task 1 legend literals.
- Gap check: chip travel from `EditorTable` → composer is covered by Tasks 3→7→6 (`pendingChip` mirrors `pendingPrompt`). Dock-open covered by `setDockTab('agent')` in Task 7.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; tests have real assertions.

**Type consistency:** `ContextChip` shape identical across Tasks 1/4/5/6/7. `onSend` payload `{text, chips}` defined in Task 5, consumed in Task 6. `insertChip` defined in Task 5 handle, called in Task 6. `createRun(prompt, wireContent?)` defined in Task 6 Step 1, used in Task 6 Step 2. `serializeDocJSON` / `serializeWithChips` signatures consistent Task 1 ↔ Tasks 5/6.
