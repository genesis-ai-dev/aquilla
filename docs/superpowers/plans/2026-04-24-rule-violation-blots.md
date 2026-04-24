# Rule Violation Blots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render inline visual decorations ("blots") on the exact text that triggers each rule violation, add per-cell-per-rule waivers so users can acknowledge a violation without hiding it, and soften the existing example-evidence highlights to prevent collision with the new violation signals.

**Architecture:** Extend `RuleInfraction` with `spans: InfractionSpan[]` and upgrade the rule engine to capture `RegExp.exec`/`matchAll` indices. Store waivers on the Y.Doc cell map as a serialized JSON array. Render two decoration channels in the editor: a soft "horizon underline" for example evidence (gated on examples panel expanded) and a crisp severity-colored "squiggle" underline for violations. The target side uses a ProseMirror decoration set injected into `TranslatedEditor`; the source side and plain-textarea fallback reuse a span-based renderer in `HighlightedText`. Clicking a violation span opens a `Popover` with the rule name, message, and Waive/Unwaive actions.

**Tech Stack:** TypeScript, React 18, Vite, Vitest, TipTap v3 / ProseMirror (`Decoration.inline`, `DecorationSet`), Yjs (cell persistence & sync), shadcn `Popover`.

---

## File Structure

**Modify:**
- `src/lib/parsers/types.ts` — add `InfractionSpan`, `RuleWaiver`; extend `RuleInfraction`.
- `src/lib/rules/rule-engine.ts` — capture regex spans per check type.
- `src/lib/rules/rule-engine.test.ts` — extend existing tests.
- `src/hooks/useCells.ts` — surface `waivers` on `CellData`.
- `src/hooks/useCellHistory.ts` — add `setCellWaivers` helper (co-located with other cell-mutation helpers).
- `src/components/HighlightedText.tsx` — add `variant: "evidence" | "violation"`, change styling.
- `src/components/ExamplePanel.tsx` — accept controlled `expanded` prop.
- `src/components/EditorTable.tsx` — thread waivers + examplesExpanded state, render popovers + violation decorations on source and plain-textarea fallback, filter gutter count by active violations.
- `src/components/TranslatedEditor.tsx` — accept `violations` prop, install ProseMirror decoration plugin.

**Create:**
- `src/lib/rules/waivers.ts` — pure helpers: `isWaived`, `addWaiver`, `removeWaiver`, `filterInfractions`.
- `src/lib/rules/waivers.test.ts`
- `src/hooks/useCellWaivers.ts` — Y.Doc write helpers for waivers.
- `src/hooks/useCellWaivers.test.ts`
- `src/components/ViolationPopover.tsx` — popover content with waive/unwaive.
- `src/components/ViolationPopover.test.tsx`
- `src/components/CellDecorationOverlay.tsx` — span-based overlay for the plain-textarea target fallback and (via shared styling constants) the source column.
- `src/lib/richtext/violation-decoration-plugin.ts` — ProseMirror plugin that builds a `DecorationSet` from a violations array.
- `src/lib/richtext/violation-decoration-plugin.test.ts`

---

## Task 1: Add types for spans and waivers

**Files:**
- Modify: `src/lib/parsers/types.ts`

- [ ] **Step 1: Add the new types**

In `src/lib/parsers/types.ts`, immediately before the existing `RuleInfraction` interface (currently at lines 65–70), add:

```ts
export interface InfractionSpan {
  /** Which side of the cell the match lives on. */
  side: "source" | "target"
  /** Character offset (inclusive) into the plain-text of that side. */
  start: number
  /** Character offset (exclusive). */
  end: number
  /** The matched substring — retained for popover context and debugging. */
  matchedText: string
}

export interface RuleWaiver {
  ruleId: string
  /** Optional human-entered reason. */
  reason?: string
  /** ISO timestamp. */
  waivedAt: string
  /** User id / username, when available. */
  waivedBy?: string
}
```

Then replace the existing `RuleInfraction` interface with:

```ts
export interface RuleInfraction {
  ruleId: string
  cellId: string
  fileId: string
  message: string
  /** Triggering text spans. Empty when the violation has no identifiable
   *  concrete match (e.g. absence rules with no source trigger) — those
   *  fall back to the gutter icon only. */
  spans: InfractionSpan[]
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. Existing callers compile because the new `spans` field is the only addition and all producers will be updated in Task 2.

If any producer in `src/lib/rules/rule-engine.ts` fails, that's fine — Task 2 updates it. To keep this task green, temporarily add `spans: []` to each infraction literal in `rule-engine.ts`. Task 2 replaces those.

- [ ] **Step 3: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/rules/rule-engine.ts
git commit -m "feat(rules): add InfractionSpan and RuleWaiver types"
```

---

## Task 2: Rule engine captures spans for `target-forbids`

**Files:**
- Modify: `src/lib/rules/rule-engine.ts`
- Modify: `src/lib/rules/rule-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/rules/rule-engine.test.ts`:

```ts
describe("infraction spans", () => {
  it("target-forbids records a span on target for each match", () => {
    const cells = new Map([["f1", [
      makeCell({ id: "c1", translated: "this is bad and also bad twice", status: "validated" }),
    ]]])
    const rules = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" } })]
    const result = checkRules(cells, rules)
    const inf = result.get("c1")![0]
    expect(inf.spans).toHaveLength(2)
    expect(inf.spans[0]).toEqual({ side: "target", start: 8, end: 11, matchedText: "bad" })
    expect(inf.spans[1]).toEqual({ side: "target", start: 21, end: 24, matchedText: "bad" })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts -t "target-forbids records a span"`
Expected: FAIL — `inf.spans` is `[]` (from the Task 1 temporary stub).

- [ ] **Step 3: Implement span capture for `target-forbids`**

In `src/lib/rules/rule-engine.ts`, replace the `case "target-forbids"` block inside `checkRule` with:

```ts
case "target-forbids": {
  const re = compile(check.targetPattern, "gi")
  if (!re) return null
  const spans: import("@/lib/parsers/types").InfractionSpan[] = []
  for (const m of cell.translated.matchAll(re)) {
    if (m.index === undefined) continue
    spans.push({ side: "target", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
  }
  if (spans.length === 0) return null
  return {
    ruleId: rule.id, cellId: cell.id, fileId,
    message: `"${rule.name}": target contains forbidden pattern`,
    spans,
  }
}
```

Note the flag change from `"i"` to `"gi"` — required for `matchAll` to iterate all matches. The cached compiled regex key already includes flags, so this creates a separate cache entry.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts -t "target-forbids records a span"`
Expected: PASS.

- [ ] **Step 5: Run the whole file to confirm no regressions**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rules/rule-engine.ts src/lib/rules/rule-engine.test.ts
git commit -m "feat(rules): capture spans for target-forbids check"
```

---

## Task 3: Rule engine captures spans for `source-target-match`

**Files:**
- Modify: `src/lib/rules/rule-engine.ts`
- Modify: `src/lib/rules/rule-engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("infraction spans")`:

```ts
it("source-target-match records source spans when source has trigger but target doesn't", () => {
  const cells = new Map([["f1", [
    makeCell({ id: "c1", original: "Chapter 5 and verse 7", translated: "Chapitre et verset", status: "validated" }),
  ]]])
  const rules = [makeRule({ id: "r1", check: { type: "source-target-match", pattern: "\\d+" } })]
  const result = checkRules(cells, rules)
  const inf = result.get("c1")![0]
  expect(inf.spans).toHaveLength(2)
  expect(inf.spans[0].side).toBe("source")
  expect(inf.spans[0].matchedText).toBe("5")
  expect(inf.spans[1].matchedText).toBe("7")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts -t "source-target-match records source spans"`
Expected: FAIL.

- [ ] **Step 3: Implement span capture for `source-target-match`**

Replace the `case "source-target-match"` block in `checkRule`:

```ts
case "source-target-match": {
  const re = compile(check.pattern, "gi")
  if (!re) return null
  re.lastIndex = 0 // cached regex — clear any leftover state before matchAll
  const sourceSpans: import("@/lib/parsers/types").InfractionSpan[] = []
  for (const m of cell.original.matchAll(re)) {
    if (m.index === undefined) continue
    sourceSpans.push({ side: "source", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
  }
  if (sourceSpans.length === 0) return null
  re.lastIndex = 0
  const targetHasMatch = re.test(cell.translated)
  re.lastIndex = 0 // reset after test() advances it on a /g regex
  if (targetHasMatch) return null
  return {
    ruleId: rule.id, cellId: cell.id, fileId,
    message: `"${rule.name}": pattern found in source but missing in target`,
    spans: sourceSpans,
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts -t "source-target-match records source spans"`
Expected: PASS.

- [ ] **Step 5: Run the whole file**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rules/rule-engine.ts src/lib/rules/rule-engine.test.ts
git commit -m "feat(rules): capture source spans for source-target-match"
```

---

## Task 4: Rule engine captures spans for `source-requires-target`

**Files:**
- Modify: `src/lib/rules/rule-engine.ts`
- Modify: `src/lib/rules/rule-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe("infraction spans")`:

```ts
it("source-requires-target records source trigger spans when target lacks required match", () => {
  const cells = new Map([["f1", [
    makeCell({ id: "c1", original: "Chapter 5 is here", translated: "Chapitre est ici", status: "validated" }),
  ]]])
  const rules = [makeRule({ id: "r1", check: { type: "source-requires-target", sourcePattern: "\\d+", targetPattern: "\\d+" } })]
  const result = checkRules(cells, rules)
  const inf = result.get("c1")![0]
  expect(inf.spans).toHaveLength(1)
  expect(inf.spans[0]).toEqual({ side: "source", start: 8, end: 9, matchedText: "5" })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts -t "source-requires-target records source trigger"`
Expected: FAIL.

- [ ] **Step 3: Implement span capture**

Replace the `case "source-requires-target"` block in `checkRule`:

```ts
case "source-requires-target": {
  const sourceRe = compile(check.sourcePattern, "gi")
  if (!sourceRe) return null
  const sourceSpans: import("@/lib/parsers/types").InfractionSpan[] = []
  for (const m of cell.original.matchAll(sourceRe)) {
    if (m.index === undefined) continue
    sourceSpans.push({ side: "source", start: m.index, end: m.index + m[0].length, matchedText: m[0] })
  }
  if (sourceSpans.length === 0) return null // source pattern not present → rule doesn't apply
  const targetRe = compile(check.targetPattern, "i")
  if (!targetRe) return null
  if (targetRe.test(cell.translated)) return null // target satisfies the requirement
  return {
    ruleId: rule.id, cellId: cell.id, fileId,
    message: `"${rule.name}": source matches pattern but target does not`,
    spans: sourceSpans,
  }
}
```

- [ ] **Step 4: Run the new test**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts -t "source-requires-target records source trigger"`
Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm no regressions anywhere**

Run: `npx vitest run`
Expected: all tests PASS. If `autofix.test.ts` fails because it asserts a `RuleInfraction` without `spans`, update the affected fixtures to include `spans: []` where the test intent is "just a placeholder infraction."

- [ ] **Step 6: Commit**

```bash
git add src/lib/rules/rule-engine.ts src/lib/rules/rule-engine.test.ts
git commit -m "feat(rules): capture source trigger spans for source-requires-target"
```

---

## Task 5: Waiver pure helpers

**Files:**
- Create: `src/lib/rules/waivers.ts`
- Create: `src/lib/rules/waivers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/rules/waivers.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { isWaived, addWaiver, removeWaiver, partitionInfractions } from "./waivers"
import type { RuleWaiver, RuleInfraction } from "@/lib/parsers/types"

const waiver = (ruleId: string, extra: Partial<RuleWaiver> = {}): RuleWaiver => ({
  ruleId, waivedAt: "2026-04-24T00:00:00Z", ...extra,
})
const inf = (ruleId: string): RuleInfraction => ({
  ruleId, cellId: "c1", fileId: "f1", message: "", spans: [],
})

describe("isWaived", () => {
  it("returns true when a waiver exists for the rule", () => {
    expect(isWaived([waiver("r1")], "r1")).toBe(true)
  })
  it("returns false when no waiver matches", () => {
    expect(isWaived([waiver("r2")], "r1")).toBe(false)
    expect(isWaived(undefined, "r1")).toBe(false)
  })
})

describe("addWaiver", () => {
  it("appends a new waiver", () => {
    const next = addWaiver([], { ruleId: "r1", reason: "ok here" }, "alice", "2026-04-24T12:00:00Z")
    expect(next).toEqual([{ ruleId: "r1", reason: "ok here", waivedBy: "alice", waivedAt: "2026-04-24T12:00:00Z" }])
  })
  it("replaces an existing waiver for the same rule", () => {
    const prev = [waiver("r1", { reason: "old" })]
    const next = addWaiver(prev, { ruleId: "r1", reason: "new" }, "alice", "2026-04-24T12:00:00Z")
    expect(next).toHaveLength(1)
    expect(next[0].reason).toBe("new")
  })
})

describe("removeWaiver", () => {
  it("removes a matching waiver", () => {
    const next = removeWaiver([waiver("r1"), waiver("r2")], "r1")
    expect(next).toEqual([waiver("r2")])
  })
  it("is a no-op when no waiver matches", () => {
    const prev = [waiver("r2")]
    const next = removeWaiver(prev, "r1")
    expect(next).toBe(prev)
  })
})

describe("partitionInfractions", () => {
  it("splits infractions into active and waived", () => {
    const infractions = [inf("r1"), inf("r2"), inf("r3")]
    const waivers = [waiver("r2")]
    expect(partitionInfractions(infractions, waivers)).toEqual({
      active: [inf("r1"), inf("r3")],
      waived: [inf("r2")],
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/rules/waivers.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/rules/waivers.ts`:

```ts
import type { RuleWaiver, RuleInfraction } from "@/lib/parsers/types"

export function isWaived(waivers: RuleWaiver[] | undefined, ruleId: string): boolean {
  if (!waivers) return false
  for (const w of waivers) if (w.ruleId === ruleId) return true
  return false
}

export function addWaiver(
  waivers: RuleWaiver[],
  input: { ruleId: string; reason?: string },
  waivedBy: string | undefined,
  waivedAt: string = new Date().toISOString(),
): RuleWaiver[] {
  const filtered = waivers.filter((w) => w.ruleId !== input.ruleId)
  const next: RuleWaiver = { ruleId: input.ruleId, waivedAt }
  if (input.reason) next.reason = input.reason
  if (waivedBy) next.waivedBy = waivedBy
  filtered.push(next)
  return filtered
}

export function removeWaiver(waivers: RuleWaiver[], ruleId: string): RuleWaiver[] {
  const next = waivers.filter((w) => w.ruleId !== ruleId)
  return next.length === waivers.length ? waivers : next
}

export function partitionInfractions(
  infractions: RuleInfraction[],
  waivers: RuleWaiver[] | undefined,
): { active: RuleInfraction[]; waived: RuleInfraction[] } {
  if (!waivers || waivers.length === 0) return { active: infractions, waived: [] }
  const active: RuleInfraction[] = []
  const waived: RuleInfraction[] = []
  for (const inf of infractions) {
    if (isWaived(waivers, inf.ruleId)) waived.push(inf)
    else active.push(inf)
  }
  return { active, waived }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/rules/waivers.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/waivers.ts src/lib/rules/waivers.test.ts
git commit -m "feat(rules): pure helpers for per-cell rule waivers"
```

---

## Task 6: Waiver Y.Doc persistence + CellData surface

**Files:**
- Create: `src/hooks/useCellWaivers.ts`
- Create: `src/hooks/useCellWaivers.test.ts`
- Modify: `src/hooks/useCells.ts`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useCellWaivers.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { setCellWaivers, readCellWaivers } from "./useCellWaivers"
import type { RuleWaiver } from "@/lib/parsers/types"

function seed(doc: Y.Doc, cellId: string) {
  const cellsMap = doc.getMap("cells")
  const cell = new Y.Map<unknown>()
  cell.set("id", cellId)
  cellsMap.set(cellId, cell)
}

describe("cell waivers", () => {
  it("writes and reads a single waiver round-trip", () => {
    const doc = new Y.Doc()
    seed(doc, "c1")
    const waiver: RuleWaiver = { ruleId: "r1", reason: "ok here", waivedAt: "2026-04-24T00:00:00Z" }
    setCellWaivers(doc, "c1", [waiver])
    expect(readCellWaivers(doc, "c1")).toEqual([waiver])
  })

  it("treats missing field as empty array", () => {
    const doc = new Y.Doc()
    seed(doc, "c1")
    expect(readCellWaivers(doc, "c1")).toEqual([])
  })

  it("is a no-op when the cell does not exist", () => {
    const doc = new Y.Doc()
    setCellWaivers(doc, "missing", [{ ruleId: "r1", waivedAt: "x" }])
    expect(readCellWaivers(doc, "missing")).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/hooks/useCellWaivers.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the persistence helpers**

Create `src/hooks/useCellWaivers.ts`:

```ts
import * as Y from "yjs"
import type { RuleWaiver } from "@/lib/parsers/types"

/**
 * Waivers are stored as a plain JSON-serialized array in cell.get("waivers").
 * The array is small (≤ rules in the project) and only rewritten on
 * waive/unwaive, so we avoid the complexity of a Y.Array of Y.Maps.
 */
export function readCellWaivers(doc: Y.Doc, cellId: string): RuleWaiver[] {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return []
  const raw = cell.get("waivers") as RuleWaiver[] | undefined
  return Array.isArray(raw) ? raw : []
}

export function setCellWaivers(doc: Y.Doc, cellId: string, waivers: RuleWaiver[]): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return
  doc.transact(() => {
    cell.set("waivers", waivers)
  })
}
```

- [ ] **Step 4: Surface `waivers` on CellData**

In `src/hooks/useCells.ts`:

1. Add to the `CellData` interface (after line 48, before the closing `}`):

```ts
  waivers?: import("@/lib/parsers/types").RuleWaiver[]
```

2. In `buildCellData` (inside the returned object, near line 151 where `sourceLocation` is read), add:

```ts
    waivers: (cell.get("waivers") as import("@/lib/parsers/types").RuleWaiver[] | undefined),
```

- [ ] **Step 5: Run the new test**

Run: `npx vitest run src/hooks/useCellWaivers.test.ts`
Expected: all PASS.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useCellWaivers.ts src/hooks/useCellWaivers.test.ts src/hooks/useCells.ts
git commit -m "feat(rules): persist waivers on Y.Doc cells; surface on CellData"
```

---

## Task 7: Filter gutter count by non-waived violations

**Files:**
- Modify: `src/components/EditorTable.tsx`

- [ ] **Step 1: Partition infractions before rendering**

In `src/components/EditorTable.tsx`, inside `MemoizedRow` near line 381 where `cellInfractions` is computed, add:

```ts
  const { active: activeInfractions, waived: waivedInfractions } = useMemo(
    () => partitionInfractions(cellInfractions, cell.waivers),
    [cellInfractions, cell.waivers],
  )
```

Add import at the top of the file:

```ts
import { partitionInfractions } from "@/lib/rules/waivers"
```

Pass both arrays through the `EditorRow` props:
- In the `EditorRow` call (around line 407), replace `cellInfractions={cellInfractions}` with:

```tsx
        cellInfractions={activeInfractions}
        waivedInfractions={waivedInfractions}
```

- In the `EditorRowProps` interface (around line 464), add:

```ts
  waivedInfractions: RuleInfraction[]
```

- In the `EditorRow` function signature (around line 497), destructure `waivedInfractions`.

- [ ] **Step 2: Leave the gutter-icon rendering unchanged**

The gutter block near line 936 already renders from `cellInfractions` — since we now pass only the active subset, waived violations drop out of the gutter automatically. No code change needed in that block.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/EditorTable.tsx
git commit -m "feat(editor): filter gutter infraction count by waivers"
```

---

## Task 8: HighlightedText variants (evidence vs violation)

**Files:**
- Modify: `src/components/HighlightedText.tsx`

- [ ] **Step 1: Extend the prop surface**

Replace the current `HighlightedText` component in `src/components/HighlightedText.tsx` with:

```tsx
import { useMemo } from "react"
import { cn } from "@/lib/utils"

export const EXAMPLE_COLORS = [
  "#3b82f6", "#f97316", "#22c55e", "#a855f7",
  "#14b8a6", "#f43f5e", "#eab308", "#6366f1",
]

export interface TokenHighlight {
  token: string
  colorIndex: number
}

export interface RangeHighlight {
  start: number
  end: number
  kind: "violation-major" | "violation-minor" | "violation-waived"
  ruleId: string
}

interface HighlightedTextProps {
  text: string
  /** Token-level evidence highlights (examples). Rendered only when
   *  `showEvidence` is true. */
  highlights?: TokenHighlight[]
  /** Byte-range violation highlights. Always rendered. */
  ranges?: RangeHighlight[]
  showEvidence?: boolean
  onRangeClick?: (ruleId: string, event: React.MouseEvent<HTMLSpanElement>) => void
}

export function HighlightedText({
  text, highlights = [], ranges = [],
  showEvidence = false, onRangeClick,
}: HighlightedTextProps) {
  const highlightMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const h of highlights) map.set(h.token.toLowerCase(), h.colorIndex)
    return map
  }, [highlights])

  const sortedRanges = useMemo(
    () => [...ranges].sort((a, b) => a.start - b.start),
    [ranges],
  )

  if (highlights.length === 0 && ranges.length === 0) return <span>{text}</span>

  // First split into { text, rangeKind?, ruleId? } chunks honoring ranges,
  // then within each non-ranged chunk apply token-level evidence highlights.
  const chunks: Array<{ text: string; start: number; range?: RangeHighlight }> = []
  let cursor = 0
  for (const r of sortedRanges) {
    if (r.start > cursor) chunks.push({ text: text.slice(cursor, r.start), start: cursor })
    chunks.push({ text: text.slice(r.start, r.end), start: r.start, range: r })
    cursor = r.end
  }
  if (cursor < text.length) chunks.push({ text: text.slice(cursor), start: cursor })

  return (
    <span>
      {chunks.map((chunk, i) => {
        if (chunk.range) {
          return (
            <span
              key={i}
              role={onRangeClick ? "button" : undefined}
              tabIndex={onRangeClick ? 0 : undefined}
              onClick={onRangeClick ? (e) => onRangeClick(chunk.range!.ruleId, e) : undefined}
              className={cn(
                "cursor-pointer",
                chunk.range.kind === "violation-major" && "decoration-wavy decoration-red-500 underline underline-offset-[3px]",
                chunk.range.kind === "violation-minor" && "decoration-wavy decoration-amber-500 underline underline-offset-[3px]",
                chunk.range.kind === "violation-waived" && "decoration-wavy decoration-muted-foreground/60 underline underline-offset-[3px] opacity-60",
              )}
              data-rule-id={chunk.range.ruleId}
            >
              {chunk.text}
            </span>
          )
        }
        if (!showEvidence || highlights.length === 0) return <span key={i}>{chunk.text}</span>
        return <EvidenceTokens key={i} text={chunk.text} highlightMap={highlightMap} />
      })}
    </span>
  )
}

function EvidenceTokens({ text, highlightMap }: { text: string; highlightMap: Map<string, number> }) {
  const parts = text.split(/(\s+)/)
  return (
    <>
      {parts.map((part, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>
        const token = part.toLowerCase().replace(/[^\w]/g, "")
        const colorIdx = highlightMap.get(token)
        if (colorIdx !== undefined) {
          const color = EXAMPLE_COLORS[colorIdx % EXAMPLE_COLORS.length]
          return (
            <span
              key={i}
              style={{
                backgroundImage: `linear-gradient(to right, transparent, ${color}80 20%, ${color}80 80%, transparent)`,
                backgroundRepeat: "no-repeat",
                backgroundSize: "100% 2px",
                backgroundPosition: "0 100%",
                paddingBottom: "1px",
              }}
            >
              {part}
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

export function buildHighlightsFromExamples(
  examples: { matchedTokens: string[] }[],
  globalColorOffset = 0
): TokenHighlight[] {
  const highlights: TokenHighlight[] = []
  const seen = new Set<string>()
  for (let i = 0; i < examples.length; i++) {
    const colorIndex = (i + globalColorOffset) % EXAMPLE_COLORS.length
    for (const token of examples[i].matchedTokens) {
      const lower = token.toLowerCase()
      if (!seen.has(lower)) { seen.add(lower); highlights.push({ token: lower, colorIndex }) }
    }
  }
  return highlights
}
```

**Behavior change:**
- Evidence tokens moved from `<mark>` with a saturated background to a soft linear-gradient underline (the "horizon underline"). They only render when `showEvidence` is true.
- Violations render as wavy underlines (red for major, amber for minor, muted for waived).
- Click on a violation span calls `onRangeClick(ruleId, event)`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. Existing callers (`EditorTable.tsx` line 852) still work because all new props are optional and `highlights` falls back to `[]`. The visual default changes only when `showEvidence` is passed (Task 10).

- [ ] **Step 3: Commit**

```bash
git add src/components/HighlightedText.tsx
git commit -m "feat(ui): HighlightedText variants — soft evidence underline, violation squiggle"
```

---

## Task 9: Lift `expanded` state out of ExamplePanel

**Files:**
- Modify: `src/components/ExamplePanel.tsx`

- [ ] **Step 1: Accept controlled `expanded` prop**

Replace the `ExamplePanel` component's head:

```tsx
import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import type { ScoredPair } from "@/lib/search/dual-index"

export function ExamplePanel({
  examples, globalColorOffset = 0,
  expanded: expandedProp,
  onExpandedChange,
}: {
  examples: ScoredPair[]
  globalColorOffset?: number
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [internal, setInternal] = useState(false)
  const expanded = expandedProp ?? internal
  const setExpanded = (next: boolean) => {
    if (onExpandedChange) onExpandedChange(next)
    else setInternal(next)
  }

  // ... rest of the component unchanged (use `expanded` and `setExpanded`)
```

Keep the rest of the component body unchanged; the button already calls `setExpanded(!expanded)`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. Existing callers that omit the new props keep the previous uncontrolled behavior.

- [ ] **Step 3: Commit**

```bash
git add src/components/ExamplePanel.tsx
git commit -m "refactor(ui): ExamplePanel accepts controlled expanded prop"
```

---

## Task 10: ViolationPopover component

**Files:**
- Create: `src/components/ViolationPopover.tsx`
- Create: `src/components/ViolationPopover.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/ViolationPopover.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ViolationPopover } from "./ViolationPopover"
import type { RuleInfraction, RuleWaiver } from "@/lib/parsers/types"

const infraction: RuleInfraction = {
  ruleId: "r1", cellId: "c1", fileId: "f1",
  message: `"No bad": target contains forbidden pattern`,
  spans: [{ side: "target", start: 0, end: 3, matchedText: "bad" }],
}

describe("ViolationPopover", () => {
  it("renders rule name, message, and a Waive button by default", () => {
    render(
      <ViolationPopover
        open infraction={infraction} ruleName="No bad" waivers={[]}
        onOpenChange={() => {}} onOpenRule={() => {}} onWaive={() => {}} onUnwaive={() => {}}
      >
        <span>anchor</span>
      </ViolationPopover>
    )
    expect(screen.getByText("No bad")).toBeInTheDocument()
    expect(screen.getByText(/forbidden pattern/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /waive/i })).toBeInTheDocument()
  })

  it("shows Unwaive when the rule is already waived", () => {
    const waivers: RuleWaiver[] = [{ ruleId: "r1", reason: "agreed", waivedAt: "2026-04-24T00:00:00Z" }]
    render(
      <ViolationPopover
        open infraction={infraction} ruleName="No bad" waivers={waivers}
        onOpenChange={() => {}} onOpenRule={() => {}} onWaive={() => {}} onUnwaive={() => {}}
      >
        <span>anchor</span>
      </ViolationPopover>
    )
    expect(screen.getByText(/Waived/)).toBeInTheDocument()
    expect(screen.getByText(/agreed/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /unwaive/i })).toBeInTheDocument()
  })

  it("calls onWaive with the submitted reason", () => {
    const onWaive = vi.fn()
    render(
      <ViolationPopover
        open infraction={infraction} ruleName="No bad" waivers={[]}
        onOpenChange={() => {}} onOpenRule={() => {}} onWaive={onWaive} onUnwaive={() => {}}
      >
        <span>anchor</span>
      </ViolationPopover>
    )
    fireEvent.click(screen.getByRole("button", { name: /waive/i }))
    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: "intentional" } })
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }))
    expect(onWaive).toHaveBeenCalledWith({ ruleId: "r1", reason: "intentional" })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/ViolationPopover.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the component**

Create `src/components/ViolationPopover.tsx`:

```tsx
import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { RuleInfraction, RuleWaiver } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

interface ViolationPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  infraction: RuleInfraction
  ruleName: string
  waivers: RuleWaiver[]
  onOpenRule: (ruleId: string) => void
  onWaive: (input: { ruleId: string; reason?: string }) => void
  onUnwaive: (ruleId: string) => void
  children: React.ReactNode
}

export function ViolationPopover({
  open, onOpenChange, infraction, ruleName, waivers,
  onOpenRule, onWaive, onUnwaive, children,
}: ViolationPopoverProps) {
  const waiver = waivers.find((w) => w.ruleId === infraction.ruleId)
  const [mode, setMode] = useState<"view" | "waive-reason">("view")
  const [reason, setReason] = useState("")

  const reset = () => { setMode("view"); setReason("") }

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 space-y-2 p-3 text-sm">
        <button
          type="button"
          className="text-left font-medium hover:underline"
          onClick={() => onOpenRule(infraction.ruleId)}
        >
          {ruleName}
        </button>
        <p className="text-xs text-muted-foreground">{infraction.message}</p>

        {waiver && (
          <div className="rounded border border-muted-foreground/20 bg-muted/30 p-2 text-xs">
            <div className="font-medium">Waived {relativeTime(waiver.waivedAt)}</div>
            {waiver.reason && <div className="mt-0.5 text-muted-foreground">{waiver.reason}</div>}
            {waiver.waivedBy && <div className="mt-0.5 text-muted-foreground">by {waiver.waivedBy}</div>}
          </div>
        )}

        {mode === "view" && !waiver && (
          <button type="button" className={buttonCls} onClick={() => setMode("waive-reason")}>
            Waive
          </button>
        )}
        {mode === "view" && waiver && (
          <button type="button" className={buttonCls} onClick={() => { onUnwaive(infraction.ruleId); reset() }}>
            Unwaive
          </button>
        )}
        {mode === "waive-reason" && (
          <div className="space-y-2">
            <input
              className="w-full rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <button type="button" className={buttonCls} onClick={() => {
                onWaive({ ruleId: infraction.ruleId, ...(reason ? { reason } : {}) })
                reset()
              }}>
                Confirm
              </button>
              <button type="button" className={cn(buttonCls, "bg-transparent")} onClick={reset}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const buttonCls = "rounded border px-2 py-1 text-xs hover:bg-muted"

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/ViolationPopover.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ViolationPopover.tsx src/components/ViolationPopover.test.tsx
git commit -m "feat(ui): ViolationPopover with waive/unwaive flow"
```

---

## Task 11: ProseMirror decoration plugin for target-side violations

**Files:**
- Create: `src/lib/richtext/violation-decoration-plugin.ts`
- Create: `src/lib/richtext/violation-decoration-plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/richtext/violation-decoration-plugin.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { EditorState } from "@tiptap/pm/state"
import { schema as basicSchema } from "@tiptap/pm/schema-basic"
import { buildViolationDecorationSet } from "./violation-decoration-plugin"
import type { RuleInfraction } from "@/lib/parsers/types"

function makeDoc(text: string) {
  return basicSchema.node("doc", null, [basicSchema.node("paragraph", null, [basicSchema.text(text)])])
}

describe("buildViolationDecorationSet", () => {
  it("creates one inline decoration per target span", () => {
    const doc = makeDoc("this is bad text")
    const state = EditorState.create({ schema: basicSchema, doc })
    const infractions: RuleInfraction[] = [{
      ruleId: "r1", cellId: "c1", fileId: "f1", message: "",
      spans: [{ side: "target", start: 8, end: 11, matchedText: "bad" }],
    }]
    const ruleSeverity = new Map([["r1", "major" as const]])
    const set = buildViolationDecorationSet(state.doc, infractions, ruleSeverity, new Set())
    const decorations = set.find()
    expect(decorations).toHaveLength(1)
    // ProseMirror text inside a paragraph starts at pos 1, so doc offset 8 → pm pos 9.
    expect(decorations[0].from).toBe(9)
    expect(decorations[0].to).toBe(12)
  })

  it("ignores source-side spans", () => {
    const doc = makeDoc("anything")
    const state = EditorState.create({ schema: basicSchema, doc })
    const infractions: RuleInfraction[] = [{
      ruleId: "r1", cellId: "c1", fileId: "f1", message: "",
      spans: [{ side: "source", start: 0, end: 4, matchedText: "xxxx" }],
    }]
    const set = buildViolationDecorationSet(state.doc, infractions, new Map(), new Set())
    expect(set.find()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/richtext/violation-decoration-plugin.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the plugin**

Create `src/lib/richtext/violation-decoration-plugin.ts`:

```ts
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import type { RuleInfraction } from "@/lib/parsers/types"

export const violationPluginKey = new PluginKey<DecorationSet>("violationDecorations")

export function buildViolationDecorationSet(
  doc: PMNode,
  infractions: RuleInfraction[],
  ruleSeverity: Map<string, "major" | "minor">,
  waivedRuleIds: Set<string>,
): DecorationSet {
  const decorations: Decoration[] = []
  // Convert plain-text offsets into ProseMirror positions by walking the doc
  // in reading order. For a single-paragraph cell (the common case —
  // TranslatedEditor disables headings/lists/blockquote), this reduces to
  // pm_pos = plain_offset + 1. Multi-paragraph cells will still work for
  // spans that live entirely inside one paragraph; spans crossing a
  // paragraph boundary are a follow-up (rare in translation cells).

  // Build a mapping: plainStart → pmPos, by walking in order.
  const plainToPm: number[] = []
  let plainCursor = 0
  doc.descendants((node, pos) => {
    if (node.isText) {
      const len = node.text?.length ?? 0
      for (let i = 0; i <= len; i++) plainToPm[plainCursor + i] = pos + i
      plainCursor += len
    }
  })
  // Sentinel for end-of-doc
  if (!(plainCursor in plainToPm)) plainToPm[plainCursor] = doc.content.size

  for (const inf of infractions) {
    for (const span of inf.spans) {
      if (span.side !== "target") continue
      const from = plainToPm[span.start]
      const to = plainToPm[span.end]
      if (from === undefined || to === undefined) continue
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      const waived = waivedRuleIds.has(inf.ruleId)
      const cls = waived
        ? "violation-blot violation-blot-waived"
        : severity === "major"
          ? "violation-blot violation-blot-major"
          : "violation-blot violation-blot-minor"
      decorations.push(Decoration.inline(from, to, {
        class: cls,
        "data-rule-id": inf.ruleId,
      }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

export function createViolationDecorationExtension(getState: () => {
  infractions: RuleInfraction[]
  ruleSeverity: Map<string, "major" | "minor">
  waivedRuleIds: Set<string>
}) {
  return Extension.create({
    name: "violationDecorations",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: violationPluginKey,
        state: {
          init: (_, state) => {
            const s = getState()
            return buildViolationDecorationSet(state.doc, s.infractions, s.ruleSeverity, s.waivedRuleIds)
          },
          apply: (tr, old, _oldState, newState) => {
            if (tr.getMeta(violationPluginKey) === "rebuild") {
              const s = getState()
              return buildViolationDecorationSet(newState.doc, s.infractions, s.ruleSeverity, s.waivedRuleIds)
            }
            if (tr.docChanged) return old.map(tr.mapping, tr.doc)
            return old
          },
        },
        props: {
          decorations(state) { return this.getState(state) },
        },
      })]
    },
  })
}
```

Add the corresponding CSS classes in `src/index.css` (append):

```css
.violation-blot {
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-skip-ink: none;
  text-underline-offset: 3px;
  cursor: pointer;
}
.violation-blot-major { text-decoration-color: theme('colors.red.500'); }
.violation-blot-minor { text-decoration-color: theme('colors.amber.500'); }
.violation-blot-waived {
  text-decoration-color: theme('colors.muted-foreground' / 60%);
  opacity: 0.6;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/richtext/violation-decoration-plugin.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/richtext/violation-decoration-plugin.ts src/lib/richtext/violation-decoration-plugin.test.ts src/index.css
git commit -m "feat(richtext): ProseMirror violation decoration plugin"
```

---

## Task 12: Wire decoration plugin into TranslatedEditor

**Files:**
- Modify: `src/components/TranslatedEditor.tsx`

- [ ] **Step 1: Accept `infractions`, `ruleSeverity`, `waivedRuleIds`, `onRuleClick` props**

In `src/components/TranslatedEditor.tsx`, extend `TranslatedEditorProps`:

```ts
import type { RuleInfraction } from "@/lib/parsers/types"
import { createViolationDecorationExtension, violationPluginKey } from "@/lib/richtext/violation-decoration-plugin"

interface TranslatedEditorProps {
  fragment: Y.XmlFragment
  onBlur?: () => void
  placeholder?: string
  className?: string
  syncProvider?: YProvider | null
  user?: { name: string; color: string }
  editable?: boolean
  infractions?: RuleInfraction[]
  ruleSeverity?: Map<string, "major" | "minor">
  waivedRuleIds?: Set<string>
  onRuleClick?: (ruleId: string, anchor: HTMLElement) => void
}
```

- [ ] **Step 2: Install the extension and rebuild on prop change**

Inside `useEditor`, after the cursor extension, append:

```ts
      createViolationDecorationExtension(() => ({
        infractions: latestViolationStateRef.current.infractions,
        ruleSeverity: latestViolationStateRef.current.ruleSeverity,
        waivedRuleIds: latestViolationStateRef.current.waivedRuleIds,
      })),
```

Add before `useEditor`:

```ts
  const latestViolationStateRef = useRef({
    infractions: props.infractions ?? [],
    ruleSeverity: props.ruleSeverity ?? new Map(),
    waivedRuleIds: props.waivedRuleIds ?? new Set<string>(),
  })
  useEffect(() => {
    latestViolationStateRef.current = {
      infractions: props.infractions ?? [],
      ruleSeverity: props.ruleSeverity ?? new Map(),
      waivedRuleIds: props.waivedRuleIds ?? new Set<string>(),
    }
    if (editor) {
      const tr = editor.state.tr.setMeta(violationPluginKey, "rebuild")
      editor.view.dispatch(tr)
    }
  }, [editor, props.infractions, props.ruleSeverity, props.waivedRuleIds])
```

(Adjust the `useEditor` closure so the `[fragment, syncProvider, user?.name, user?.color]` deps list is untouched — the ref keeps the decoration inputs reactive without re-creating the editor.)

- [ ] **Step 3: Install a DOM click handler for violation spans**

Inside `EditorContent`'s wrapper (the `<div className="relative">`), attach:

```tsx
<EditorContent
  editor={editor}
  onClick={(e) => {
    const target = e.target as HTMLElement
    const blot = target.closest("[data-rule-id]")
    if (blot && props.onRuleClick) {
      props.onRuleClick(blot.getAttribute("data-rule-id")!, blot as HTMLElement)
    }
  }}
/>
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TranslatedEditor.tsx
git commit -m "feat(richtext): TranslatedEditor renders violation decorations"
```

---

## Task 13: Render violations on the source column and plain-textarea fallback; wire popover

**Files:**
- Modify: `src/components/EditorTable.tsx`

- [ ] **Step 1: Add popover state and waiver handler in EditorRow**

In `EditorRow` (around line 500), add:

```ts
  const [openRuleId, setOpenRuleId] = useState<string | null>(null)
  const [examplesExpanded, setExamplesExpanded] = useState(false)
  const ruleSeverity = useMemo(() => {
    const m = new Map<string, "major" | "minor">()
    for (const [id, rule] of ruleMap) m.set(id, rule.severity)
    return m
  }, [ruleMap])
  const waivedRuleIds = useMemo(() => new Set((cell.waivers ?? []).map(w => w.ruleId)), [cell.waivers])

  const handleWaive = useCallback((input: { ruleId: string; reason?: string }) => {
    const next = addWaiver(cell.waivers ?? [], input, username)
    setCellWaivers(doc, cell.id, next)
    setOpenRuleId(null)
  }, [cell.waivers, cell.id, doc, username])

  const handleUnwaive = useCallback((ruleId: string) => {
    const next = removeWaiver(cell.waivers ?? [], ruleId)
    setCellWaivers(doc, cell.id, next)
    setOpenRuleId(null)
  }, [cell.waivers, cell.id, doc])
```

Add imports:

```ts
import { addWaiver, removeWaiver } from "@/lib/rules/waivers"
import { setCellWaivers } from "@/hooks/useCellWaivers"
import { ViolationPopover } from "./ViolationPopover"
import type { RangeHighlight } from "./HighlightedText"
```

- [ ] **Step 2: Build RangeHighlight arrays for source and (fallback) target**

Also inside `EditorRow`:

```ts
  const sourceRanges = useMemo<RangeHighlight[]>(() => {
    const out: RangeHighlight[] = []
    for (const inf of [...cellInfractions, ...waivedInfractions]) {
      const waived = waivedRuleIds.has(inf.ruleId)
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      for (const span of inf.spans) {
        if (span.side !== "source") continue
        out.push({
          start: span.start, end: span.end, ruleId: inf.ruleId,
          kind: waived ? "violation-waived" : (severity === "major" ? "violation-major" : "violation-minor"),
        })
      }
    }
    return out
  }, [cellInfractions, waivedInfractions, waivedRuleIds, ruleSeverity])

  const targetRanges = useMemo<RangeHighlight[]>(() => {
    if (cell.translatedXml) return [] // target side is handled by ProseMirror plugin
    const out: RangeHighlight[] = []
    for (const inf of [...cellInfractions, ...waivedInfractions]) {
      const waived = waivedRuleIds.has(inf.ruleId)
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      for (const span of inf.spans) {
        if (span.side !== "target") continue
        out.push({
          start: span.start, end: span.end, ruleId: inf.ruleId,
          kind: waived ? "violation-waived" : (severity === "major" ? "violation-major" : "violation-minor"),
        })
      }
    }
    return out
  }, [cellInfractions, waivedInfractions, waivedRuleIds, ruleSeverity, cell.translatedXml])
```

- [ ] **Step 3: Render the source column with HighlightedText-and-ranges**

Replace the source-column plain-text branch (currently lines 849–857):

```tsx
        ) : (
          <div className="text-sm">
            <HighlightedText
              text={cell.original}
              highlights={highlights}
              ranges={sourceRanges}
              showEvidence={examplesExpanded}
              onRangeClick={(ruleId) => setOpenRuleId(ruleId)}
            />
          </div>
        )}
```

The `originalHtml` branch is unchanged in v1 (formatted source cells are rare; span offsets over HTML are a follow-up).

- [ ] **Step 4: Thread the lifted `expanded` state into ExamplePanel**

Replace the current `ExamplePanel` call (just after the source column render) with:

```tsx
        {cellExamples.length > 0 && (
          <ExamplePanel
            examples={cellExamples}
            expanded={examplesExpanded}
            onExpandedChange={setExamplesExpanded}
          />
        )}
```

- [ ] **Step 5: Render the plain-textarea fallback with an overlay**

Replace the `textarea` branch in the target column (currently lines 873–881) with:

```tsx
          ) : (
            <div className="relative">
              <textarea
                className="w-full resize-none rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-70"
                value={cell.translated}
                onChange={handleChange}
                readOnly={!editable}
                rows={Math.max(2, Math.ceil(cell.original.length / 50))}
              />
              {targetRanges.length > 0 && (
                <div
                  className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-2 py-1 text-sm"
                  aria-hidden
                >
                  <HighlightedText
                    text={cell.translated}
                    ranges={targetRanges}
                    // evidence layer isn't applicable here
                  />
                </div>
              )}
            </div>
          )}
```

The overlay is visually aligned by matching the textarea's font/padding. Interactivity stays on the textarea; the overlay is `pointer-events-none` so the underline renders but clicks fall through. Clicking the squiggle happens via the gutter icon for plain-textarea cells (textareas can't host inline Popover anchors reliably).

- [ ] **Step 6: Pass decorations to TranslatedEditor**

Replace the `TranslatedEditor` call in the target column:

```tsx
            <TranslatedEditor
              fragment={cell.translatedXml}
              className="w-full"
              syncProvider={syncProvider}
              user={collabUser}
              onBlur={handleEditorBlur}
              editable={editable}
              infractions={[...cellInfractions, ...waivedInfractions]}
              ruleSeverity={ruleSeverity}
              waivedRuleIds={waivedRuleIds}
              onRuleClick={(ruleId) => setOpenRuleId(ruleId)}
            />
```

- [ ] **Step 7: Render the popover**

Add right before the gutter `<div>` (around line 912):

```tsx
      {openRuleId && (() => {
        const inf = [...cellInfractions, ...waivedInfractions].find((i) => i.ruleId === openRuleId)
        const rule = ruleMap.get(openRuleId)
        if (!inf || !rule) return null
        return (
          <ViolationPopover
            open
            onOpenChange={(next) => { if (!next) setOpenRuleId(null) }}
            infraction={inf}
            ruleName={rule.name}
            waivers={cell.waivers ?? []}
            onOpenRule={(ruleId) => { setOpenRuleId(null); onInfractionClick?.(ruleId) }}
            onWaive={handleWaive}
            onUnwaive={handleUnwaive}
          >
            <span />
          </ViolationPopover>
        )
      })()}
```

(The trigger `<span />` is a placeholder anchor — shadcn `Popover` positions around it. Because we open the popover programmatically via `openRuleId`, its exact position matters less than its visibility; real anchoring to the specific blot is a v1.1 polish.)

- [ ] **Step 8: Type-check and manual smoke**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/EditorTable.tsx
git commit -m "feat(editor): render violation blots, evidence underlines, waive popover"
```

---

## Task 14: End-to-end verification in the browser

**Files:** none modified.

- [ ] **Step 1: Start dev server**

Run: `npm run dev` (or use `preview_start`).
Expected: server starts on the usual Vite port.

- [ ] **Step 2: Load a project with at least one rule and one violating cell**

Open the app, pick or create a project with a `target-forbids` rule that matches a substring in an existing translation.

- [ ] **Step 3: Confirm the violation renders**

Look at the violating cell: the offending substring in the target column should carry a red (major) or amber (minor) wavy underline. The gutter icon still shows.

- [ ] **Step 4: Click the blot**

A popover opens showing the rule name and message, plus a Waive button.

- [ ] **Step 5: Waive and confirm**

Enter a reason (e.g. "intentional"), click Confirm. The squiggle turns muted (low opacity), the gutter icon disappears. Refresh the page — the waiver survives (Y.Doc persistence).

- [ ] **Step 6: Unwaive**

Re-click the (now muted) blot, click Unwaive. Squiggle returns to crisp colored form and the gutter icon reappears.

- [ ] **Step 7: Confirm source-side blots for `source-requires-target`**

Create / enable a rule that requires a number in the target when one is present in the source. Find a cell where the source has a number but the target doesn't. Expand the cell's Examples panel — the source digit should have a wavy underline.

- [ ] **Step 8: Confirm evidence underline is gated**

With the Examples panel collapsed, the source column has no horizon-underline highlights for example tokens. Expand the panel — the soft gradient underlines appear only then.

- [ ] **Step 9: Commit any CSS/wiring tweaks needed during verification**

If visual adjustments were required (padding alignment between textarea and overlay, underline offset, etc.), commit them individually:

```bash
git add -p
git commit -m "fix(editor): <what you adjusted>"
```

---

## Post-implementation checklist

- [ ] All new tests pass: `npx vitest run`
- [ ] Type check clean: `npx tsc --noEmit`
- [ ] Lint clean: `npx eslint .`
- [ ] Manual verification steps in Task 14 all green in the browser
- [ ] No console errors in the dev server logs when interacting with a cell that has violations
