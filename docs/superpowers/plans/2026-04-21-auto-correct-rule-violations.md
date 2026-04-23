# Auto-correct Rule Violations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users click one button on a translation rule to have an LLM propose a fix for every current violation, preview the result per cell, multi-select, and apply — with saved autofixes cached per rule, per-cell surgical fixes via a sparkle button, and project-level LLM/usage counters.

**Architecture:** New `autofix.ts` module beside the existing `rule-engine.ts` / `rule-suggester.ts` handles a programmatic-first cascade (regex-replace → per-cell semantic). New `useAutofix` hook orchestrates preview generation and apply-by-commit through the existing `commit-cell-edit` pipeline. New `FixReviewPanel` sheet renders previews with multi-select. Usage counters live on `ProjectRecord.usage` and are written via a single centralized helper.

**Tech Stack:** TypeScript, React, Vitest, Yjs (for cell edits), IndexedDB project store, existing `complete()` completion service.

**Spec:** `docs/superpowers/specs/2026-04-21-auto-correct-rule-violations-design.md`

---

## Task 1: Extend types for autofix + usage

**Files:**
- Modify: `src/lib/parsers/types.ts`

- [ ] **Step 1: Add `RuleAutofix`, extend `TranslationRule`**

In `src/lib/parsers/types.ts`, directly after the `RuleCheck` export (around line 45), add:

```ts
export type RuleAutofix =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string }
```

Then extend the existing `TranslationRule` interface (around line 30) by adding these fields inside the interface body (keep every existing field untouched):

```ts
  autofix?: RuleAutofix
  autofixAttemptedAt?: string  // ISO; absent means never tried
```

- [ ] **Step 2: Add `ProjectUsage`, extend `ProjectRecord`**

In the same file, add a new interface near the other project-scoped types (after `RulePenalties`):

```ts
export interface ProjectUsage {
  llmCalls: Record<string, {
    total: number
    byModel: Record<string, number>
    byProvider: Record<string, number>
  }>
  fixesApplied: number
}
```

Extend `ProjectRecord` (around line 59) by adding inside the interface body:

```ts
  usage?: ProjectUsage
```

- [ ] **Step 3: Run the typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS (new optional fields don't break existing call sites).

- [ ] **Step 4: Commit**

```bash
git add src/lib/parsers/types.ts
git commit -m "feat(types): add RuleAutofix and ProjectUsage for auto-correct"
```

---

## Task 2: Usage recording helper (TDD)

**Files:**
- Create: `src/lib/usage/record-usage.ts`
- Create: `src/lib/usage/record-usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/usage/record-usage.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { addLlmCall, addFixApplied } from "./record-usage"
import type { ProjectRecord } from "@/lib/parsers/types"

function baseProject(): ProjectRecord {
  return {
    id: "p1", name: "Demo", sourceLanguage: "en", targetLanguage: "fr",
    files: [], createdAt: "2026-04-21T00:00:00Z", updatedAt: "2026-04-21T00:00:00Z",
  } as ProjectRecord
}

describe("addLlmCall", () => {
  it("initializes usage when absent", () => {
    const p = addLlmCall(baseProject(), { kind: "autofix-batch-regex", model: "opus-4-7", provider: "frontier" })
    expect(p.usage?.llmCalls["autofix-batch-regex"]).toEqual({
      total: 1,
      byModel: { "opus-4-7": 1 },
      byProvider: { frontier: 1 },
    })
    expect(p.usage?.fixesApplied).toBe(0)
  })

  it("increments existing counters", () => {
    const initial = addLlmCall(baseProject(), { kind: "rule-suggestion", model: "m", provider: "custom" })
    const next = addLlmCall(initial, { kind: "rule-suggestion", model: "m", provider: "custom" })
    expect(next.usage?.llmCalls["rule-suggestion"].total).toBe(2)
    expect(next.usage?.llmCalls["rule-suggestion"].byModel.m).toBe(2)
    expect(next.usage?.llmCalls["rule-suggestion"].byProvider.custom).toBe(2)
  })

  it("tracks multiple kinds and models", () => {
    let p = addLlmCall(baseProject(), { kind: "autofix-batch-regex", model: "a", provider: "frontier" })
    p = addLlmCall(p, { kind: "autofix-surgical", model: "b", provider: "frontier" })
    p = addLlmCall(p, { kind: "autofix-batch-regex", model: "a", provider: "custom" })
    expect(Object.keys(p.usage!.llmCalls).sort()).toEqual(["autofix-batch-regex", "autofix-surgical"])
    expect(p.usage!.llmCalls["autofix-batch-regex"].byProvider).toEqual({ frontier: 1, custom: 1 })
  })

  it("handles missing model gracefully", () => {
    const p = addLlmCall(baseProject(), { kind: "autofix-batch-regex", provider: "frontier" })
    expect(p.usage?.llmCalls["autofix-batch-regex"].byModel).toEqual({ "(default)": 1 })
  })
})

describe("addFixApplied", () => {
  it("increments from zero", () => {
    const p = addFixApplied(baseProject())
    expect(p.usage?.fixesApplied).toBe(1)
  })

  it("accumulates", () => {
    const p = addFixApplied(addFixApplied(baseProject()))
    expect(p.usage?.fixesApplied).toBe(2)
  })

  it("preserves existing llmCalls", () => {
    const p1 = addLlmCall(baseProject(), { kind: "x", model: "m", provider: "frontier" })
    const p2 = addFixApplied(p1)
    expect(p2.usage?.llmCalls.x.total).toBe(1)
    expect(p2.usage?.fixesApplied).toBe(1)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run src/lib/usage/record-usage.test.ts`
Expected: FAIL with "Cannot find module './record-usage'".

- [ ] **Step 3: Implement `record-usage.ts`**

Create `src/lib/usage/record-usage.ts`:

```ts
import type { ProjectRecord, ProjectUsage } from "@/lib/parsers/types"

interface LlmCallMeta {
  kind: string
  model?: string
  provider: string
}

function emptyUsage(): ProjectUsage {
  return { llmCalls: {}, fixesApplied: 0 }
}

export function addLlmCall(project: ProjectRecord, meta: LlmCallMeta): ProjectRecord {
  const usage: ProjectUsage = project.usage ? cloneUsage(project.usage) : emptyUsage()
  const key = meta.kind
  const bucket = usage.llmCalls[key] || { total: 0, byModel: {}, byProvider: {} }
  const modelKey = meta.model?.trim() || "(default)"
  bucket.total += 1
  bucket.byModel[modelKey] = (bucket.byModel[modelKey] || 0) + 1
  bucket.byProvider[meta.provider] = (bucket.byProvider[meta.provider] || 0) + 1
  usage.llmCalls[key] = bucket
  return { ...project, usage }
}

export function addFixApplied(project: ProjectRecord): ProjectRecord {
  const usage: ProjectUsage = project.usage ? cloneUsage(project.usage) : emptyUsage()
  usage.fixesApplied += 1
  return { ...project, usage }
}

function cloneUsage(u: ProjectUsage): ProjectUsage {
  const llmCalls: ProjectUsage["llmCalls"] = {}
  for (const [k, v] of Object.entries(u.llmCalls)) {
    llmCalls[k] = { total: v.total, byModel: { ...v.byModel }, byProvider: { ...v.byProvider } }
  }
  return { llmCalls, fixesApplied: u.fixesApplied }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx vitest run src/lib/usage/record-usage.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage/record-usage.ts src/lib/usage/record-usage.test.ts
git commit -m "feat(usage): add project-level LLM call and fix counters"
```

---

## Task 3: Pure autofix application functions (TDD)

**Files:**
- Create: `src/lib/rules/autofix.ts`
- Create: `src/lib/rules/autofix.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/rules/autofix.test.ts` with the pure-function slice only:

```ts
import { describe, it, expect } from "vitest"
import { applyRegexFix, applyLiteralFix } from "./autofix"

describe("applyRegexFix", () => {
  it("replaces all matches with global flag", () => {
    const fix = { kind: "regex-replace" as const, pattern: "\\bfoo\\b", replacement: "bar", flags: "gi" }
    expect(applyRegexFix(fix, "foo and Foo and foobar")).toBe("bar and bar and foobar")
  })

  it("replaces first only without global flag", () => {
    const fix = { kind: "regex-replace" as const, pattern: "foo", replacement: "bar", flags: "i" }
    expect(applyRegexFix(fix, "foo and foo")).toBe("bar and foo")
  })

  it("supports capture-group backreferences", () => {
    const fix = { kind: "regex-replace" as const, pattern: "(\\d+) dollars", replacement: "$$$1", flags: "g" }
    expect(applyRegexFix(fix, "5 dollars and 10 dollars")).toBe("$5 and $10")
  })

  it("returns original text when pattern does not match", () => {
    const fix = { kind: "regex-replace" as const, pattern: "xyz", replacement: "q", flags: "g" }
    expect(applyRegexFix(fix, "abc")).toBe("abc")
  })

  it("throws for invalid regex", () => {
    const fix = { kind: "regex-replace" as const, pattern: "(", replacement: "x", flags: "g" }
    expect(() => applyRegexFix(fix, "anything")).toThrow()
  })
})

describe("applyLiteralFix", () => {
  it("replaces all occurrences literally", () => {
    expect(applyLiteralFix("don't", "do not", "I don't but you don't either")).toBe("I do not but you do not either")
  })

  it("preserves surrounding formatting (markdown-like)", () => {
    expect(applyLiteralFix("foo", "bar", "**foo** and _foo_")).toBe("**bar** and _bar_")
  })

  it("returns original when find not present", () => {
    expect(applyLiteralFix("x", "y", "abc")).toBe("abc")
  })

  it("is safe with regex metacharacters in find", () => {
    expect(applyLiteralFix("a.b", "ab", "a.b and a.b and axb")).toBe("ab and ab and axb")
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: FAIL with "Cannot find module './autofix'".

- [ ] **Step 3: Implement the pure functions**

Create `src/lib/rules/autofix.ts`:

```ts
import type { RuleAutofix } from "@/lib/parsers/types"

export function applyRegexFix(fix: RuleAutofix, translated: string): string {
  const re = new RegExp(fix.pattern, fix.flags)
  return translated.replace(re, fix.replacement)
}

// Literal replace-all. Does NOT treat `find` as a regex.
export function applyLiteralFix(find: string, replace: string, translated: string): string {
  if (find.length === 0) return translated
  return translated.split(find).join(replace)
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/autofix.ts src/lib/rules/autofix.test.ts
git commit -m "feat(autofix): pure regex and literal fix application"
```

---

## Task 4: Autofix proposal types + JSON parsers (TDD)

**Files:**
- Modify: `src/lib/rules/autofix.ts`
- Modify: `src/lib/rules/autofix.test.ts`

- [ ] **Step 1: Append failing parse tests**

Append to `src/lib/rules/autofix.test.ts`:

```ts
import { parseBatchResponse, parsePerCellResponse } from "./autofix"

describe("parseBatchResponse", () => {
  it("parses a regex-replace response", () => {
    const raw = `{"kind":"regex-replace","pattern":"foo","replacement":"bar","flags":"gi","rationale":"r"}`
    expect(parseBatchResponse(raw)).toEqual({
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "gi", rationale: "r",
    })
  })

  it("parses a none response", () => {
    const raw = `{"kind":"none","reason":"too semantic"}`
    expect(parseBatchResponse(raw)).toEqual({ kind: "none", reason: "too semantic" })
  })

  it("strips markdown code fences", () => {
    const raw = "```json\n{\"kind\":\"none\",\"reason\":\"r\"}\n```"
    expect(parseBatchResponse(raw)).toEqual({ kind: "none", reason: "r" })
  })

  it("returns null for invalid JSON", () => {
    expect(parseBatchResponse("not json")).toBeNull()
  })

  it("returns null for unknown kind", () => {
    expect(parseBatchResponse(`{"kind":"ignore"}`)).toBeNull()
  })

  it("returns null when regex-replace is missing required fields", () => {
    expect(parseBatchResponse(`{"kind":"regex-replace","pattern":"p"}`)).toBeNull()
  })
})

describe("parsePerCellResponse", () => {
  it("parses valid fixes", () => {
    const raw = `{"kind":"per-cell","fixes":[{"cellId":"c1","find":"a","replace":"b","rationale":"r"}]}`
    const parsed = parsePerCellResponse(raw)
    expect(parsed?.kind).toBe("per-cell")
    expect(parsed?.kind === "per-cell" && parsed.fixes).toHaveLength(1)
  })

  it("parses none", () => {
    const raw = `{"kind":"none","reason":"r"}`
    expect(parsePerCellResponse(raw)).toEqual({ kind: "none", reason: "r" })
  })

  it("filters malformed fix entries", () => {
    const raw = JSON.stringify({
      kind: "per-cell",
      fixes: [
        { cellId: "c1", find: "a", replace: "b" },
        { cellId: "c2", find: "x" }, // missing replace
        { find: "a", replace: "b" },  // missing cellId
        "bad",
      ],
    })
    const parsed = parsePerCellResponse(raw)
    expect(parsed?.kind === "per-cell" && parsed.fixes.map((f) => f.cellId)).toEqual(["c1"])
  })

  it("returns null for invalid JSON", () => {
    expect(parsePerCellResponse("garbage")).toBeNull()
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: FAIL with missing `parseBatchResponse` / `parsePerCellResponse`.

- [ ] **Step 3: Add parser implementations**

Append to `src/lib/rules/autofix.ts`:

```ts
export interface PerCellFix {
  cellId: string
  find: string
  replace: string
  rationale?: string
}

export type BatchResponse =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string; rationale?: string }
  | { kind: "none"; reason: string }

export type PerCellResponse =
  | { kind: "per-cell"; fixes: PerCellFix[] }
  | { kind: "none"; reason: string }

function stripFences(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return ""
  return s.slice(start, end + 1)
}

export function parseBatchResponse(raw: string): BatchResponse | null {
  const cleaned = stripFences(raw)
  if (!cleaned) return null
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return null }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  if (obj.kind === "regex-replace") {
    if (typeof obj.pattern !== "string" || typeof obj.replacement !== "string" || typeof obj.flags !== "string") {
      return null
    }
    return {
      kind: "regex-replace",
      pattern: obj.pattern,
      replacement: obj.replacement,
      flags: obj.flags,
      rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
    }
  }
  if (obj.kind === "none") {
    return { kind: "none", reason: typeof obj.reason === "string" ? obj.reason : "No reason given" }
  }
  return null
}

export function parsePerCellResponse(raw: string): PerCellResponse | null {
  const cleaned = stripFences(raw)
  if (!cleaned) return null
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return null }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  if (obj.kind === "none") {
    return { kind: "none", reason: typeof obj.reason === "string" ? obj.reason : "No reason given" }
  }
  if (obj.kind !== "per-cell" || !Array.isArray(obj.fixes)) return null
  const fixes: PerCellFix[] = []
  for (const f of obj.fixes) {
    if (!f || typeof f !== "object") continue
    const fx = f as Record<string, unknown>
    if (typeof fx.cellId !== "string" || typeof fx.find !== "string" || typeof fx.replace !== "string") continue
    fixes.push({
      cellId: fx.cellId, find: fx.find, replace: fx.replace,
      rationale: typeof fx.rationale === "string" ? fx.rationale : undefined,
    })
  }
  return { kind: "per-cell", fixes }
}
```

- [ ] **Step 4: Run — verify passes**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: PASS (all tests, 18+ including Task 3's).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/autofix.ts src/lib/rules/autofix.test.ts
git commit -m "feat(autofix): JSON parsers for batch and per-cell LLM responses"
```

---

## Task 5: `FixProposal` builder + preview assembly (TDD)

**Files:**
- Modify: `src/lib/rules/autofix.ts`
- Modify: `src/lib/rules/autofix.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/lib/rules/autofix.test.ts`:

```ts
import { buildRegexProposal, buildPerCellProposal } from "./autofix"
import type { CellData } from "@/hooks/useCells"

function cell(id: string, translated: string, original = ""): CellData {
  return {
    id, original, translated, fileId: "f1", status: "translated",
  } as CellData
}

describe("buildRegexProposal", () => {
  it("produces previews only for cells the regex changes", () => {
    const prop = buildRegexProposal(
      { kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" },
      [cell("c1", "foo here"), cell("c2", "no match"), cell("c3", "another foo")],
      "llm",
    )
    expect(prop.kind).toBe("regex-replace")
    if (prop.kind !== "regex-replace") throw new Error("wrong kind")
    expect(prop.previews.map((p) => p.cellId)).toEqual(["c1", "c3"])
    expect(prop.previews[0]).toMatchObject({ before: "foo here", after: "bar here", source: "llm" })
  })

  it("marks source as cached-regex when flagged", () => {
    const prop = buildRegexProposal(
      { kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" },
      [cell("c1", "foo")],
      "cached-regex",
    )
    if (prop.kind !== "regex-replace") throw new Error("wrong kind")
    expect(prop.previews[0].source).toBe("cached-regex")
  })
})

describe("buildPerCellProposal", () => {
  it("produces a preview per valid fix and filters hallucinated find strings", () => {
    const cells = [cell("c1", "I don't go"), cell("c2", "do nothing"), cell("c3", "hello world")]
    const response = {
      kind: "per-cell" as const,
      fixes: [
        { cellId: "c1", find: "don't", replace: "do not" },
        { cellId: "c2", find: "banana", replace: "x" },   // hallucinated — filter
        { cellId: "c3", find: "world", replace: "earth" },
        { cellId: "c999", find: "a", replace: "b" },       // unknown cell — filter
      ],
    }
    const prop = buildPerCellProposal(response, cells)
    if (prop.kind !== "per-cell") throw new Error("wrong kind")
    expect(prop.previews.map((p) => p.cellId)).toEqual(["c1", "c3"])
    expect(prop.previews[0]).toMatchObject({ before: "I don't go", after: "I do not go", find: "don't", replace: "do not" })
  })
})
```

- [ ] **Step 2: Run — verify failure**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: FAIL with missing `buildRegexProposal` / `buildPerCellProposal`.

- [ ] **Step 3: Implement the builders**

Append to `src/lib/rules/autofix.ts`:

```ts
import type { CellData } from "@/hooks/useCells"

export interface FixPreview {
  cellId: string
  fileId: string
  before: string
  after: string
  find?: string
  replace?: string
  source: "llm" | "cached-regex"
  rationale?: string
}

export type FixProposal =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string; rationale?: string; previews: FixPreview[] }
  | { kind: "per-cell"; previews: FixPreview[] }
  | { kind: "none"; reason: string }

export function buildRegexProposal(
  fix: RuleAutofix,
  cells: CellData[],
  source: "llm" | "cached-regex",
  rationale?: string,
): FixProposal {
  const previews: FixPreview[] = []
  for (const c of cells) {
    let after: string
    try { after = applyRegexFix(fix, c.translated) } catch { continue }
    if (after === c.translated) continue
    previews.push({
      cellId: c.id, fileId: c.fileId, before: c.translated, after, source, rationale,
    })
  }
  return { kind: "regex-replace", pattern: fix.pattern, replacement: fix.replacement, flags: fix.flags, rationale, previews }
}

export function buildPerCellProposal(
  response: { kind: "per-cell"; fixes: PerCellFix[] },
  cells: CellData[],
): FixProposal {
  const byId = new Map(cells.map((c) => [c.id, c]))
  const previews: FixPreview[] = []
  for (const fx of response.fixes) {
    const c = byId.get(fx.cellId)
    if (!c) continue
    if (!c.translated.includes(fx.find)) continue   // hallucination guard
    const after = applyLiteralFix(fx.find, fx.replace, c.translated)
    if (after === c.translated) continue
    previews.push({
      cellId: c.id, fileId: c.fileId, before: c.translated, after,
      find: fx.find, replace: fx.replace, source: "llm", rationale: fx.rationale,
    })
  }
  return { kind: "per-cell", previews }
}
```

- [ ] **Step 4: Run — verify passes**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/autofix.ts src/lib/rules/autofix.test.ts
git commit -m "feat(autofix): FixProposal builder with hallucination guard"
```

---

## Task 6: LLM cascade `requestBatchFix` + `requestSurgicalFix`

**Files:**
- Modify: `src/lib/rules/autofix.ts`
- Modify: `src/lib/rules/autofix.test.ts`

- [ ] **Step 1: Append failing cascade tests**

Append to `src/lib/rules/autofix.test.ts`:

```ts
import { vi } from "vitest"
import { requestBatchFix, requestSurgicalFix } from "./autofix"
import type { TranslationRule, CompletionSettings } from "@/lib/parsers/types"

// Mock the completion service so tests don't hit the network.
vi.mock("@/lib/completion/completion-service", () => ({
  complete: vi.fn(),
}))

import { complete } from "@/lib/completion/completion-service"

const settings: CompletionSettings = {
  endpoint: "", model: "m", maxTokens: 1024, temperature: 0.2, systemPrompt: "", llmHealthPenalty: 0.1,
}

const sampleRule: TranslationRule = {
  id: "r1", name: "No 'foo'", description: "", severity: "minor", source: "llm", scope: "project",
  check: { type: "target-forbids", targetPattern: "foo" }, enabled: true, createdAt: "",
}

describe("requestBatchFix", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  it("returns regex-replace when LLM returns a working regex", async () => {
    vi.mocked(complete).mockResolvedValueOnce(`{"kind":"regex-replace","pattern":"foo","replacement":"bar","flags":"g"}`)
    const cells = [cell("c1", "foo here"), cell("c2", "clean"), cell("c3", "foo again")]
    const passing = [cell("p1", "ok")]
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: cells, passingCells: passing, settings, session: null })
    expect(prop.kind).toBe("regex-replace")
    if (prop.kind !== "regex-replace") return
    expect(prop.previews.map((p) => p.cellId)).toEqual(["c1", "c3"])
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1)
  })

  it("falls back to per-cell when LLM returns none and violations < 10", async () => {
    vi.mocked(complete)
      .mockResolvedValueOnce(`{"kind":"none","reason":"semantic"}`)
      .mockResolvedValueOnce(`{"kind":"per-cell","fixes":[{"cellId":"c1","find":"foo","replace":"bar"}]}`)
    const cells = [cell("c1", "foo here"), cell("c2", "clean foo")]
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: cells, passingCells: [], settings, session: null })
    expect(prop.kind).toBe("per-cell")
    if (prop.kind !== "per-cell") return
    expect(prop.previews).toHaveLength(1)
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2)
  })

  it("does not attempt semantic when violations >= 10 and attempt 1 fails", async () => {
    vi.mocked(complete).mockResolvedValueOnce(`{"kind":"none","reason":"nope"}`)
    const cells = Array.from({ length: 10 }, (_, i) => cell(`c${i}`, `foo ${i}`))
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: cells, passingCells: [], settings, session: null })
    expect(prop.kind).toBe("none")
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1)
  })

  it("returns none with safe reason when complete throws", async () => {
    vi.mocked(complete).mockRejectedValueOnce(new Error("boom"))
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: [cell("c1", "foo")], passingCells: [], settings, session: null })
    expect(prop).toEqual({ kind: "none", reason: "Could not apply fixes" })
  })

  it("coerces to none if regex does not change any breaking cell", async () => {
    vi.mocked(complete)
      .mockResolvedValueOnce(`{"kind":"regex-replace","pattern":"xyz","replacement":"q","flags":"g"}`)
      .mockResolvedValueOnce(`{"kind":"none","reason":"still nothing"}`)
    const prop = await requestBatchFix({ rule: sampleRule, violatingCells: [cell("c1", "foo")], passingCells: [], settings, session: null })
    // regex didn't change the cell → coerced to none → semantic fallback runs (1 violation < 10)
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2)
    expect(prop.kind).toBe("none")
  })
})

describe("requestSurgicalFix", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  it("returns a per-cell proposal for a single cell", async () => {
    vi.mocked(complete).mockResolvedValueOnce(`{"kind":"per-cell","fixes":[{"cellId":"c1","find":"foo","replace":"bar"}]}`)
    const prop = await requestSurgicalFix({ rule: sampleRule, cell: cell("c1", "foo here"), settings, session: null })
    expect(prop.kind).toBe("per-cell")
    if (prop.kind !== "per-cell") return
    expect(prop.previews[0]).toMatchObject({ before: "foo here", after: "bar here" })
  })

  it("returns none on network error", async () => {
    vi.mocked(complete).mockRejectedValueOnce(new Error("net"))
    const prop = await requestSurgicalFix({ rule: sampleRule, cell: cell("c1", "foo"), settings, session: null })
    expect(prop).toEqual({ kind: "none", reason: "Could not apply fixes" })
  })
})
```

- [ ] **Step 2: Run — verify failure**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: FAIL — missing `requestBatchFix` / `requestSurgicalFix`.

- [ ] **Step 3: Add the cascade implementation**

Append to `src/lib/rules/autofix.ts`:

```ts
import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings, TranslationRule } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

const BATCH_SYSTEM_PROMPT = `You are a translation QA engineer. Given a rule and examples of cells that follow it vs. cells that break it, propose a single regex-based fix that transforms breaking cells into following cells.

Output ONLY valid JSON matching one of these shapes:

{ "kind": "regex-replace", "pattern": "regex string", "replacement": "replacement string (may use $1 backrefs)", "flags": "gi", "rationale": "one sentence" }
{ "kind": "none", "reason": "one-sentence reason" }

Rules:
- The fix MUST apply only to the cell's translated content.
- Use JavaScript regex syntax. Escape backslashes in JSON: \\\\b for \\b.
- Prefer narrow patterns. Avoid matches that could over-fire.
- If a single regex cannot correct all breaking examples without risking false positives, return { "kind": "none", "reason": "..." }.

Output ONLY JSON. No markdown, no code fences, no explanation.`

const PER_CELL_SYSTEM_PROMPT = `You are a translation editor. For each cell listed below, identify the smallest substring of the translated text that must change to satisfy the rule, and propose its replacement. Preserve all formatting, punctuation, and surrounding text.

Output ONLY valid JSON:

{ "kind": "per-cell", "fixes": [ { "cellId": "...", "find": "exact substring in translated", "replace": "corrected substring", "rationale": "one sentence" } ] }

If a cell cannot be fixed safely, omit it from fixes. If no cells can be fixed, return { "kind": "none", "reason": "..." }.

The "find" string MUST appear verbatim in that cell's translated text.

Output ONLY JSON. No markdown, no code fences, no explanation.`

function describeCheck(rule: TranslationRule): string {
  const c = rule.check
  if (c.type === "target-forbids") return `Target must not contain /${c.targetPattern}/i`
  if (c.type === "source-target-match") return `Pattern /${c.pattern}/gi must appear in both source and target when present in source`
  return `When source matches /${c.sourcePattern}/i, target must match /${c.targetPattern}/i`
}

function buildBatchUserMessage(rule: TranslationRule, breaking: CellData[], passing: CellData[]): string {
  const breakSample = breaking.slice(0, 10)
  const passSample = passing.slice(0, 5)
  const fmt = (cs: CellData[]) =>
    cs.map((c, i) => `${i + 1}. Source: "${c.original}"\n   Target: "${c.translated}"`).join("\n\n") || "(none)"
  return [
    `Rule name: ${rule.name}`,
    `Severity: ${rule.severity}`,
    `Description: ${rule.description || "(none)"}`,
    `Check: ${describeCheck(rule)}`,
    ``,
    `Cells FOLLOWING the rule:`,
    fmt(passSample),
    ``,
    `Cells BREAKING the rule (fix these):`,
    fmt(breakSample),
    ``,
    `Propose a JSON fix per the output contract.`,
  ].join("\n")
}

function buildPerCellUserMessage(rule: TranslationRule, breaking: CellData[]): string {
  const list = breaking
    .map((c) => `- cellId: ${c.id}\n  source: "${c.original}"\n  translated: "${c.translated}"`)
    .join("\n")
  return [
    `Rule name: ${rule.name}`,
    `Description: ${rule.description || "(none)"}`,
    `Check: ${describeCheck(rule)}`,
    ``,
    `Cells to fix:`,
    list,
  ].join("\n")
}

export interface RequestBatchFixParams {
  rule: TranslationRule
  violatingCells: CellData[]
  passingCells: CellData[]
  settings: CompletionSettings
  session: FrontierSession | null
  onLlmCall?: (meta: { kind: string; model?: string; provider: string }) => void
}

export async function requestBatchFix(params: RequestBatchFixParams): Promise<FixProposal> {
  const { rule, violatingCells, passingCells, settings, session, onLlmCall } = params
  const provider = settings.provider || "frontier"
  const model = settings.model
  let raw: string
  try {
    raw = await complete({
      settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2048), temperature: 0.2 },
      session,
      messages: [
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content: buildBatchUserMessage(rule, violatingCells, passingCells) },
      ],
    })
    onLlmCall?.({ kind: "autofix-batch-regex", model, provider })
  } catch {
    return { kind: "none", reason: "Could not apply fixes" }
  }
  const parsed = parseBatchResponse(raw)
  if (parsed && parsed.kind === "regex-replace") {
    const autofix: RuleAutofix = {
      kind: "regex-replace", pattern: parsed.pattern, replacement: parsed.replacement, flags: parsed.flags,
    }
    const proposal = buildRegexProposal(autofix, violatingCells, "llm", parsed.rationale)
    if (proposal.kind === "regex-replace" && proposal.previews.length > 0) return proposal
  }
  if (violatingCells.length >= 10) {
    return { kind: "none", reason: parsed && parsed.kind === "none" ? parsed.reason : "Could not apply fixes" }
  }
  let rawSemantic: string
  try {
    rawSemantic = await complete({
      settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 4096), temperature: 0.2 },
      session,
      messages: [
        { role: "system", content: PER_CELL_SYSTEM_PROMPT },
        { role: "user", content: buildPerCellUserMessage(rule, violatingCells) },
      ],
    })
    onLlmCall?.({ kind: "autofix-batch-semantic", model, provider })
  } catch {
    return { kind: "none", reason: "Could not apply fixes" }
  }
  const semantic = parsePerCellResponse(rawSemantic)
  if (!semantic || semantic.kind === "none") {
    return { kind: "none", reason: semantic?.reason || "Could not apply fixes" }
  }
  const built = buildPerCellProposal(semantic, violatingCells)
  if (built.kind === "per-cell" && built.previews.length === 0) {
    return { kind: "none", reason: "Could not apply fixes" }
  }
  return built
}

export interface RequestSurgicalFixParams {
  rule: TranslationRule
  cell: CellData
  settings: CompletionSettings
  session: FrontierSession | null
  onLlmCall?: (meta: { kind: string; model?: string; provider: string }) => void
}

export async function requestSurgicalFix(params: RequestSurgicalFixParams): Promise<FixProposal> {
  const { rule, cell, settings, session, onLlmCall } = params
  const provider = settings.provider || "frontier"
  const model = settings.model
  let raw: string
  try {
    raw = await complete({
      settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 1024), temperature: 0.2 },
      session,
      messages: [
        { role: "system", content: PER_CELL_SYSTEM_PROMPT },
        { role: "user", content: buildPerCellUserMessage(rule, [cell]) },
      ],
    })
    onLlmCall?.({ kind: "autofix-surgical", model, provider })
  } catch {
    return { kind: "none", reason: "Could not apply fixes" }
  }
  const parsed = parsePerCellResponse(raw)
  if (!parsed || parsed.kind === "none") {
    return { kind: "none", reason: parsed?.reason || "Could not apply fixes" }
  }
  const built = buildPerCellProposal(parsed, [cell])
  if (built.kind === "per-cell" && built.previews.length === 0) {
    return { kind: "none", reason: "Could not apply fixes" }
  }
  return built
}
```

- [ ] **Step 4: Run — verify passes**

Run: `npx vitest run src/lib/rules/autofix.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/autofix.ts src/lib/rules/autofix.test.ts
git commit -m "feat(autofix): LLM cascade for batch and surgical fix requests"
```

---

## Task 7: Retrofit `rule-suggester` to record LLM calls

**Files:**
- Modify: `src/lib/rules/rule-suggester.ts`
- Modify: `src/lib/rules/rule-suggester.test.ts`

- [ ] **Step 1: Add failing test for tracking callback**

Append to `src/lib/rules/rule-suggester.test.ts`:

```ts
import { vi, beforeEach } from "vitest"
import { suggestRulesFromPairs } from "./rule-suggester"

vi.mock("@/lib/completion/completion-service", () => ({ complete: vi.fn() }))
import { complete } from "@/lib/completion/completion-service"

describe("suggestRulesFromPairs usage callback", () => {
  beforeEach(() => vi.mocked(complete).mockReset())

  it("invokes onLlmCall with kind=rule-suggestion after a successful call", async () => {
    vi.mocked(complete).mockResolvedValueOnce("[]")
    const onLlmCall = vi.fn()
    await suggestRulesFromPairs(
      [{ source: "a", target: "b" }],
      { endpoint: "", model: "m", maxTokens: 512, temperature: 0.2, systemPrompt: "", llmHealthPenalty: 0.1, provider: "custom" },
      null,
      onLlmCall,
    )
    expect(onLlmCall).toHaveBeenCalledTimes(1)
    expect(onLlmCall.mock.calls[0][0]).toMatchObject({ kind: "rule-suggestion", provider: "custom", model: "m" })
  })
})
```

- [ ] **Step 2: Run — verify failure**

Run: `npx vitest run src/lib/rules/rule-suggester.test.ts`
Expected: FAIL — fourth argument not accepted.

- [ ] **Step 3: Add the optional callback**

In `src/lib/rules/rule-suggester.ts`, modify the exported function signature and add the callback after the `complete()` call:

```ts
export type UsageCallback = (meta: { kind: string; model?: string; provider: string }) => void

export async function suggestRulesFromPairs(
  pairs: { source: string; target: string }[],
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<RuleSuggestion[]> {
  if (pairs.length === 0) return []

  const sample = pairs.slice(0, 20)
  const pairsText = sample
    .map((p, i) => `${i + 1}. Source: "${p.source}"\n   Target: "${p.target}"`)
    .join("\n\n")

  const userMessage = `Analyze these ${sample.length} human-validated translation pairs and propose rules:\n\n${pairsText}\n\nReturn a JSON array of rule suggestions.`

  const response = await complete({
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2048), temperature: 0.2 },
    session,
    messages: [
      { role: "system", content: RULE_SUGGESTION_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  })

  onLlmCall?.({ kind: "rule-suggestion", model: settings.model, provider: settings.provider || "frontier" })

  return parseRuleSuggestions(response)
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/rules/rule-suggester.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/rule-suggester.ts src/lib/rules/rule-suggester.test.ts
git commit -m "feat(rule-suggester): emit usage callback for rule-suggestion calls"
```

---

## Task 8: `useAutofix` hook (TDD)

**Files:**
- Create: `src/hooks/useAutofix.ts`
- Create: `src/hooks/useAutofix.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useAutofix.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import * as Y from "yjs"

vi.mock("@/lib/rules/autofix", async (orig) => {
  const actual = await orig<typeof import("@/lib/rules/autofix")>()
  return { ...actual, requestBatchFix: vi.fn(), requestSurgicalFix: vi.fn() }
})
vi.mock("@/lib/store/project-index", () => ({ updateProject: vi.fn(async () => {}) }))

import { useAutofix } from "./useAutofix"
import { requestBatchFix, requestSurgicalFix } from "@/lib/rules/autofix"
import { updateProject } from "@/lib/store/project-index"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

function baseProject(rule?: TranslationRule): ProjectRecord {
  return {
    id: "p1", name: "Demo", sourceLanguage: "en", targetLanguage: "fr",
    files: [], createdAt: "", updatedAt: "", rules: rule ? [rule] : [],
    completionSettings: {
      endpoint: "", model: "m", maxTokens: 1024, temperature: 0.2,
      systemPrompt: "", llmHealthPenalty: 0.1, provider: "frontier",
    },
  } as ProjectRecord
}

const rule: TranslationRule = {
  id: "r1", name: "r", description: "", severity: "minor", source: "llm", scope: "project",
  check: { type: "target-forbids", targetPattern: "foo" }, enabled: true, createdAt: "",
}

function makeCell(id: string, translated: string): CellData {
  return { id, original: "src", translated, fileId: "f1", status: "translated" } as CellData
}

function setupDoc(cells: { id: string; value: string }[]): Y.Doc {
  const doc = new Y.Doc()
  const map = doc.getMap("cells")
  for (const c of cells) {
    const cell = new Y.Map()
    cell.set("translated", c.value)
    map.set(c.id, cell)
  }
  return doc
}

describe("useAutofix.tryFixAll", () => {
  beforeEach(() => {
    vi.mocked(requestBatchFix).mockReset()
    vi.mocked(requestSurgicalFix).mockReset()
    vi.mocked(updateProject).mockReset()
  })

  it("uses cached regex when rule.autofix exists and it changes at least one cell", async () => {
    const ruleWithFix: TranslationRule = { ...rule, autofix: { kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" } }
    const project = baseProject(ruleWithFix)
    const cells = [makeCell("c1", "foo here"), makeCell("c2", "no match")]
    const doc = setupDoc([{ id: "c1", value: "foo here" }, { id: "c2", value: "no match" }])

    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    let proposal: any
    await act(async () => {
      proposal = await result.current.tryFixAll(ruleWithFix)
    })
    expect(proposal.kind).toBe("regex-replace")
    expect(proposal.previews.map((p: any) => p.cellId)).toEqual(["c1"])
    expect(proposal.previews[0].source).toBe("cached-regex")
    expect(vi.mocked(requestBatchFix)).not.toHaveBeenCalled()
  })

  it("falls back to LLM when cached regex produces no previews", async () => {
    const ruleWithFix: TranslationRule = { ...rule, autofix: { kind: "regex-replace", pattern: "xyz", replacement: "q", flags: "g" } }
    const project = baseProject(ruleWithFix)
    const cells = [makeCell("c1", "foo here")]
    vi.mocked(requestBatchFix).mockResolvedValueOnce({
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
      previews: [{ cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" }],
    })
    const doc = setupDoc([{ id: "c1", value: "foo here" }])
    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    await act(async () => { await result.current.tryFixAll(ruleWithFix) })
    expect(vi.mocked(requestBatchFix)).toHaveBeenCalledTimes(1)
  })

  it("applies selected previews, commits to Yjs, saves autofix on first apply, and increments counters", async () => {
    const project = baseProject(rule)
    const cells = [makeCell("c1", "foo here"), makeCell("c2", "foo again")]
    vi.mocked(requestBatchFix).mockResolvedValueOnce({
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
      previews: [
        { cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" },
        { cellId: "c2", fileId: "f1", before: "foo again", after: "bar again", source: "llm" },
      ],
    })
    const doc = setupDoc([{ id: "c1", value: "foo here" }, { id: "c2", value: "foo again" }])
    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    let proposal: any
    await act(async () => { proposal = await result.current.tryFixAll(rule) })

    await act(async () => {
      await result.current.applyProposal(rule, proposal, new Set(["c1", "c2"]))
    })

    // Yjs cells updated
    const c1 = (doc.getMap("cells").get("c1") as Y.Map<unknown>).get("translated")
    expect(c1).toBe("bar here")
    // updateProject called with rule.autofix set and usage counters incremented
    expect(vi.mocked(updateProject)).toHaveBeenCalled()
    const saved = vi.mocked(updateProject).mock.calls.at(-1)![0]
    const savedRule = saved.rules!.find((r) => r.id === "r1")!
    expect(savedRule.autofix).toEqual({ kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g" })
    expect(saved.usage?.fixesApplied).toBe(1)
  })

  it("skips cells whose text changed between preview and apply (staleness)", async () => {
    const project = baseProject(rule)
    const cells = [makeCell("c1", "foo here")]
    const doc = setupDoc([{ id: "c1", value: "foo here" }])
    const proposal = {
      kind: "regex-replace" as const, pattern: "foo", replacement: "bar", flags: "g",
      previews: [{ cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" as const }],
    }
    // Mutate cell externally before apply so regex no longer matches.
    ;(doc.getMap("cells").get("c1") as Y.Map<unknown>).set("translated", "nothing to match")
    const { result } = renderHook(() => useAutofix({ project, doc, username: "alice", refresh: () => {}, cellsByFile: new Map([["f1", cells]]) }))
    let report: any
    await act(async () => {
      report = await result.current.applyProposal(rule, proposal, new Set(["c1"]))
    })
    expect(report.applied).toBe(0)
    expect(report.skipped).toBe(1)
  })
})
```

- [ ] **Step 2: Run — verify failure**

Run: `npx vitest run src/hooks/useAutofix.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useAutofix.ts`. Note the `projectRef` pattern — it keeps mutations consistent across multiple awaits inside one user interaction (tryFixAll → applyProposal) even when the consumer doesn't re-render between them:

```ts
import { useCallback, useEffect, useRef, useState } from "react"
import type * as Y from "yjs"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, TranslationRule } from "@/lib/parsers/types"
import {
  buildRegexProposal,
  requestBatchFix,
  requestSurgicalFix,
  applyRegexFix,
  applyLiteralFix,
  type FixProposal,
} from "@/lib/rules/autofix"
import { addFixApplied, addLlmCall } from "@/lib/usage/record-usage"
import { updateProject } from "@/lib/store/project-index"
import { appendCellHistory } from "@/hooks/useCellHistory"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { checkRules } from "@/lib/rules/rule-engine"

interface Params {
  project: ProjectRecord
  doc: Y.Doc | null
  username: string
  refresh: () => void
  cellsByFile: Map<string, CellData[]>
}

interface ApplyReport { applied: number; skipped: number }

export function useAutofix(params: Params) {
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null)

  // Keep the most recently-persisted project in a ref so that chained mutations
  // (tryFixAll stamps attemptedAt, then applyProposal saves autofix + counters)
  // layer on top of each other even if the consumer hasn't re-rendered yet.
  const projectRef = useRef(params.project)
  useEffect(() => { projectRef.current = params.project }, [params.project])

  const getViolatingCells = useCallback((rule: TranslationRule): CellData[] => {
    const infractions = checkRules(params.cellsByFile, [rule])
    const ids = new Set(infractions.keys())
    const out: CellData[] = []
    for (const cells of params.cellsByFile.values()) {
      for (const c of cells) if (ids.has(c.id)) out.push(c)
    }
    return out
  }, [params.cellsByFile])

  const getPassingCells = useCallback((rule: TranslationRule): CellData[] => {
    const infractions = checkRules(params.cellsByFile, [rule])
    const ids = new Set(infractions.keys())
    const out: CellData[] = []
    for (const cells of params.cellsByFile.values()) {
      for (const c of cells) {
        if (c.status !== "empty" && !ids.has(c.id)) out.push(c)
      }
    }
    return out
  }, [params.cellsByFile])

  async function recordUsage(meta: { kind: string; model?: string; provider: string }) {
    const next = addLlmCall(projectRef.current, meta)
    projectRef.current = next
    await updateProject(next)
    params.refresh()
  }

  async function stampAttempted(rule: TranslationRule) {
    const now = new Date().toISOString()
    const nextRules = (projectRef.current.rules || []).map((r) =>
      r.id === rule.id ? { ...r, autofixAttemptedAt: now } : r
    )
    const next = { ...projectRef.current, rules: nextRules }
    projectRef.current = next
    await updateProject(next)
    params.refresh()
  }

  const tryFixAll = useCallback(async (rule: TranslationRule): Promise<FixProposal> => {
    setBusyRuleId(rule.id)
    try {
      const violating = getViolatingCells(rule)
      if (rule.autofix) {
        const cached = buildRegexProposal(rule.autofix, violating, "cached-regex")
        if (cached.kind === "regex-replace" && cached.previews.length > 0) return cached
      }
      const settings = params.project.completionSettings
      if (!settings) return { kind: "none", reason: "Could not apply fixes" }
      const passing = getPassingCells(rule)
      const proposal = await requestBatchFix({
        rule, violatingCells: violating, passingCells: passing, settings, session: null,
        onLlmCall: (meta) => { void recordUsage(meta) },
      })
      await stampAttempted(rule)
      return proposal
    } finally {
      setBusyRuleId(null)
    }
  }, [params.project.completionSettings, getPassingCells, getViolatingCells])

  const tryFixOne = useCallback(async (rule: TranslationRule, cell: CellData): Promise<FixProposal> => {
    setBusyRuleId(rule.id)
    try {
      const settings = params.project.completionSettings
      if (!settings) return { kind: "none", reason: "Could not apply fixes" }
      return await requestSurgicalFix({
        rule, cell, settings, session: null,
        onLlmCall: (meta) => { void recordUsage(meta) },
      })
    } finally {
      setBusyRuleId(null)
    }
  }, [params.project.completionSettings])

  const applyProposal = useCallback(
    async (rule: TranslationRule, proposal: FixProposal, selected: Set<string>): Promise<ApplyReport> => {
      if (proposal.kind === "none") return { applied: 0, skipped: 0 }
      const doc = params.doc
      if (!doc) return { applied: 0, skipped: 0 }

      let applied = 0
      let skipped = 0
      for (const preview of proposal.previews) {
        if (!selected.has(preview.cellId)) continue
        const cell = doc.getMap("cells").get(preview.cellId) as Y.Map<unknown> | undefined
        if (!cell) { skipped++; continue }
        const current = (cell.get("translated") as string) || ""
        let next: string
        try {
          if (proposal.kind === "regex-replace") {
            next = applyRegexFix({ kind: "regex-replace", pattern: proposal.pattern, replacement: proposal.replacement, flags: proposal.flags }, current)
          } else {
            if (!preview.find || preview.replace === undefined) { skipped++; continue }
            if (!current.includes(preview.find)) { skipped++; continue }
            next = applyLiteralFix(preview.find, preview.replace, current)
          }
        } catch { skipped++; continue }
        if (next === current) { skipped++; continue }
        const author = `autofix:rule-${rule.id}`
        appendCellHistory(doc, preview.cellId, { value: next, source: "llm", author, validated: false })
        commitCellEdit(doc, preview.cellId, author, ["value"], next, "llm")
        applied++
      }

      if (applied > 0) {
        let updated = projectRef.current
        if (proposal.kind === "regex-replace" && !rule.autofix) {
          const nextRules = (updated.rules || []).map((r) =>
            r.id === rule.id
              ? { ...r, autofix: { kind: "regex-replace" as const, pattern: proposal.pattern, replacement: proposal.replacement, flags: proposal.flags }, autofixAttemptedAt: new Date().toISOString() }
              : r
          )
          updated = { ...updated, rules: nextRules }
        }
        updated = addFixApplied(updated)
        projectRef.current = updated
        await updateProject(updated)
        params.refresh()
      }
      return { applied, skipped }
    },
    [params.doc, params.refresh],
  )

  return { busyRuleId, tryFixAll, tryFixOne, applyProposal }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/hooks/useAutofix.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAutofix.ts src/hooks/useAutofix.test.tsx
git commit -m "feat(autofix): useAutofix orchestrator hook with apply-by-commit"
```

---

## Task 9: `FixReviewPanel` component (TDD)

**Files:**
- Create: `src/components/FixReviewPanel.tsx`
- Create: `src/components/FixReviewPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/FixReviewPanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FixReviewPanel } from "./FixReviewPanel"
import type { FixProposal } from "@/lib/rules/autofix"
import type { TranslationRule } from "@/lib/parsers/types"

const rule: TranslationRule = {
  id: "r1", name: "No 'foo'", description: "", severity: "minor", source: "llm", scope: "project",
  check: { type: "target-forbids", targetPattern: "foo" }, enabled: true, createdAt: "",
}

function proposalWithTwo(): FixProposal {
  return {
    kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
    previews: [
      { cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" },
      { cellId: "c2", fileId: "f1", before: "foo again", after: "bar again", source: "llm" },
    ],
  }
}

describe("FixReviewPanel", () => {
  it("renders previews with all rows pre-checked", () => {
    render(
      <FixReviewPanel open={true} rule={rule} proposal={proposalWithTwo()}
        onClose={() => {}} onApply={vi.fn()} onAmendRule={() => {}} />
    )
    expect(screen.getByText(/2 previews ready/i)).toBeInTheDocument()
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes.length).toBeGreaterThanOrEqual(2)
    for (const cb of checkboxes) expect((cb as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole("button", { name: /apply 2 selected/i })).toBeInTheDocument()
  })

  it("updates the apply count when a row is unchecked", () => {
    render(<FixReviewPanel open={true} rule={rule} proposal={proposalWithTwo()}
      onClose={() => {}} onApply={vi.fn()} onAmendRule={() => {}} />)
    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])
    expect(screen.getByRole("button", { name: /apply 1 selected/i })).toBeInTheDocument()
  })

  it("calls onApply with selected cellIds", () => {
    const onApply = vi.fn()
    render(<FixReviewPanel open={true} rule={rule} proposal={proposalWithTwo()}
      onClose={() => {}} onApply={onApply} onAmendRule={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /apply 2 selected/i }))
    expect(onApply).toHaveBeenCalledWith(new Set(["c1", "c2"]))
  })

  it("renders empty state with amend button for kind=none", () => {
    const onAmend = vi.fn()
    render(<FixReviewPanel open={true} rule={rule}
      proposal={{ kind: "none", reason: "too semantic" }}
      onClose={() => {}} onApply={vi.fn()} onAmendRule={onAmend} />)
    expect(screen.getByText(/too semantic/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /amend rule/i }))
    expect(onAmend).toHaveBeenCalled()
  })

  it("shows 'Cached regex' mode badge when any preview is cached", () => {
    const proposal: FixProposal = {
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
      previews: [{ cellId: "c1", fileId: "f1", before: "foo", after: "bar", source: "cached-regex" }],
    }
    render(<FixReviewPanel open={true} rule={rule} proposal={proposal}
      onClose={() => {}} onApply={vi.fn()} onAmendRule={() => {}} />)
    expect(screen.getByText(/cached regex/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run — verify failure**

Run: `npx vitest run src/components/FixReviewPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/components/FixReviewPanel.tsx`:

```tsx
import { useMemo, useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import type { FixProposal } from "@/lib/rules/autofix"
import type { TranslationRule } from "@/lib/parsers/types"

interface Props {
  open: boolean
  rule: TranslationRule
  proposal: FixProposal
  onClose: () => void
  onApply: (selectedCellIds: Set<string>) => void
  onAmendRule: () => void
}

export function FixReviewPanel({ open, rule, proposal, onClose, onApply, onAmendRule }: Props) {
  const previews = proposal.kind === "none" ? [] : proposal.previews
  const initialSelected = useMemo(() => new Set(previews.map((p) => p.cellId)), [previews])
  const [selected, setSelected] = useState<Set<string>>(initialSelected)

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  function selectAll() { setSelected(new Set(previews.map((p) => p.cellId))) }
  function selectNone() { setSelected(new Set()) }

  const modeLabel =
    proposal.kind === "regex-replace"
      ? previews.some((p) => p.source === "cached-regex") ? "Cached regex" : "Batch regex"
      : proposal.kind === "per-cell" ? "Per-cell rewrite" : ""

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent side="right" className="w-[520px] max-w-[90vw] sm:max-w-[520px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span>{rule.name}</span>
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted">{rule.severity}</span>
            {modeLabel && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">{modeLabel}</span>}
          </SheetTitle>
        </SheetHeader>

        {proposal.kind === "none" ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">{proposal.reason}</p>
            <Button variant="outline" onClick={onAmendRule}>Amend rule</Button>
          </div>
        ) : (
          <>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{previews.length} previews ready</p>
              <div className="flex gap-2 text-xs">
                <button className="underline" onClick={selectAll}>Select all</button>
                <button className="underline" onClick={selectNone}>Select none</button>
              </div>
            </div>

            <ul className="mt-2 max-h-[60vh] space-y-2 overflow-auto">
              {previews.map((p) => (
                <li key={p.cellId} className="rounded border p-2 text-xs">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={selected.has(p.cellId)} onChange={() => toggle(p.cellId)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] text-muted-foreground">Cell {p.cellId}</div>
                      <div className="truncate line-through text-red-600 dark:text-red-400">{p.before}</div>
                      <div className="truncate text-green-700 dark:text-green-400">{p.after}</div>
                      {p.rationale && <div className="mt-1 text-[10px] text-muted-foreground">{p.rationale}</div>}
                    </div>
                  </label>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => onApply(selected)} disabled={selected.size === 0}>
                Apply {selected.size} selected
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/FixReviewPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/FixReviewPanel.tsx src/components/FixReviewPanel.test.tsx
git commit -m "feat(autofix): FixReviewPanel sheet with multi-select apply"
```

---

## Task 10: Wire `FixReviewPanel` into `RuleDrawer`

**Files:**
- Modify: `src/components/RuleDrawer.tsx`
- Modify: `src/components/ProjectWorkspace.tsx` (pass the bits `RuleDrawer` now needs)

- [ ] **Step 1: Extend `RuleDrawer` props**

In `src/components/RuleDrawer.tsx`, modify the `RuleDrawerProps` interface and add the new buttons. Replace the existing file content with:

```tsx
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { X, AlertTriangle, AlertCircle, Sparkles, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FixReviewPanel } from "./FixReviewPanel"
import type { TranslationRule, RuleInfraction, ProjectRecord } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FixProposal } from "@/lib/rules/autofix"
import { useAutofix } from "@/hooks/useAutofix"
import type * as Y from "yjs"

interface RuleDrawerProps {
  rule: TranslationRule | null
  infractions: RuleInfraction[]
  cells: CellData[]
  onClose: () => void
  onNavigateToCell: (cellId: string) => void
  project: ProjectRecord | null
  doc: Y.Doc | null
  username: string
  refresh: () => void
  cellsByFile: Map<string, CellData[]>
}

export function RuleDrawer({
  rule, infractions, cells, onClose, onNavigateToCell,
  project, doc, username, refresh, cellsByFile,
}: RuleDrawerProps) {
  const navigate = useNavigate()
  const autofix = useAutofix({ project: project!, doc, username, refresh, cellsByFile })
  const [panelProposal, setPanelProposal] = useState<FixProposal | null>(null)
  const [surgicalFor, setSurgicalFor] = useState<{ cellId: string; proposal: FixProposal } | null>(null)

  if (!rule || !project) return null

  const cellMap = new Map(cells.map((c) => [c.id, c]))
  const infractionCells = infractions.map((inf) => ({ infraction: inf, cell: cellMap.get(inf.cellId) })).filter((x) => x.cell)
  const infractionCellIds = new Set(infractions.map((i) => i.cellId))
  const passingCells = cells.filter((c) => c.status !== "empty" && !infractionCellIds.has(c.id)).slice(0, 10)

  const SeverityIcon = rule.severity === "major" ? AlertTriangle : AlertCircle
  const severityColor = rule.severity === "major" ? "text-red-500" : "text-amber-500"

  const isBusy = autofix.busyRuleId === rule.id
  const hasSavedFix = !!rule.autofix

  async function onTryFixAll() {
    if (!rule) return
    const proposal = await autofix.tryFixAll(rule)
    setPanelProposal(proposal)
  }

  async function onTryFixOne(cell: CellData) {
    if (!rule) return
    const proposal = await autofix.tryFixOne(rule, cell)
    setSurgicalFor({ cellId: cell.id, proposal })
  }

  async function onApplyPanel(selected: Set<string>) {
    if (!rule || !panelProposal) return
    await autofix.applyProposal(rule, panelProposal, selected)
    setPanelProposal(null)
  }

  async function onApplySurgical() {
    if (!rule || !surgicalFor) return
    await autofix.applyProposal(rule, surgicalFor.proposal, new Set([surgicalFor.cellId]))
    setSurgicalFor(null)
  }

  function onAmendRule() {
    navigate(`/project/${project!.id}/rules?ruleId=${rule!.id}&focus=autofix`)
  }

  return (
    <div className="flex h-full w-80 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <SeverityIcon className={`h-4 w-4 ${severityColor}`} />
          <h3 className="text-sm font-semibold">{rule.name}</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button size="sm" onClick={onTryFixAll} disabled={isBusy || infractions.length === 0}>
          <Wand2 className="mr-1 h-3.5 w-3.5" />
          {isBusy ? (hasSavedFix ? "Applying cached fix…" : "Analyzing…") : "Try to fix all"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onAmendRule}>Amend rule</Button>
      </div>

      <div className="border-b px-3 py-1 text-[10px] text-muted-foreground">
        {hasSavedFix
          ? `Saved autofix: /${rule.autofix!.pattern}/${rule.autofix!.flags} → ${rule.autofix!.replacement}`
          : "No saved fix yet"}
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-4">
        {rule.description && <p className="text-xs text-muted-foreground">{rule.description}</p>}

        <div>
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Breaking this rule ({infractionCells.length})
          </p>
          {infractionCells.length === 0 ? (
            <p className="text-xs text-muted-foreground">None</p>
          ) : (
            <ul className="space-y-1">
              {infractionCells.slice(0, 20).map(({ infraction, cell }) => (
                <li key={infraction.cellId} className="flex items-start gap-1">
                  <button
                    className="flex-1 rounded border-l-2 border-red-400 bg-red-50 p-1.5 text-left text-xs hover:bg-red-100 dark:bg-red-950/20 dark:hover:bg-red-950/40"
                    onClick={() => onNavigateToCell(infraction.cellId)}
                  >
                    <div className="truncate text-muted-foreground">{cell!.original.slice(0, 60)}...</div>
                    <div className="truncate font-medium">{cell!.translated.slice(0, 60)}...</div>
                  </button>
                  <Button variant="ghost" size="sm" className="h-6 px-1" disabled={isBusy} onClick={() => onTryFixOne(cell!)}>
                    <Sparkles className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Following this rule ({passingCells.length}{passingCells.length >= 10 ? "+" : ""})
          </p>
          {passingCells.length === 0 ? (
            <p className="text-xs text-muted-foreground">No translated cells yet</p>
          ) : (
            <ul className="space-y-1">
              {passingCells.map((cell) => (
                <li key={cell.id}>
                  <button
                    className="w-full rounded border-l-2 border-green-400 bg-green-50 p-1.5 text-left text-xs hover:bg-green-100 dark:bg-green-950/20 dark:hover:bg-green-950/40"
                    onClick={() => onNavigateToCell(cell.id)}
                  >
                    <div className="truncate text-muted-foreground">{cell.original.slice(0, 60)}...</div>
                    <div className="truncate font-medium">{cell.translated.slice(0, 60)}...</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {panelProposal && (
        <FixReviewPanel
          open={!!panelProposal} rule={rule} proposal={panelProposal}
          onClose={() => setPanelProposal(null)} onApply={onApplyPanel} onAmendRule={onAmendRule}
        />
      )}
      {surgicalFor && (
        <FixReviewPanel
          open={!!surgicalFor} rule={rule} proposal={surgicalFor.proposal}
          onClose={() => setSurgicalFor(null)}
          onApply={onApplySurgical}
          onAmendRule={onAmendRule}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Update `ProjectWorkspace.tsx` call site**

Open `src/components/ProjectWorkspace.tsx`. Locate the `<RuleDrawer ... />` usage (currently around line 639) and replace it with:

```tsx
{drawerRuleId && (
  <RuleDrawer
    rule={drawerRule}
    infractions={drawerInfractions}
    cells={cells}
    onClose={() => setDrawerRuleId(null)}
    onNavigateToCell={() => {}}
    project={project}
    doc={doc}
    username={username}
    refresh={refresh}
    cellsByFile={cellsByFile}
  />
)}
```

If `cellsByFile`, `doc`, `username`, or `refresh` are not yet in scope at that location, add the locals by reading existing hook calls higher in the component (the component already builds the infractions map from cells; `cellsByFile` should be constructed where those are grouped). If `cellsByFile` is not yet computed, add above the `return`:

```tsx
const cellsByFile = useMemo(() => {
  const map = new Map<string, CellData[]>()
  for (const c of cells) {
    if (!map.has(c.fileId)) map.set(c.fileId, [])
    map.get(c.fileId)!.push(c)
  }
  return map
}, [cells])
```

- [ ] **Step 3: Run typecheck and tests**

Run: `npx tsc -p tsconfig.app.json --noEmit && npx vitest run`
Expected: PASS. If `ProjectWorkspace.tsx` requires other imports (useMemo, CellData), add them.

- [ ] **Step 4: Commit**

```bash
git add src/components/RuleDrawer.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(autofix): wire Try-to-fix-all and sparkle into RuleDrawer"
```

---

## Task 11: Rules page inline autofix + query-param expansion

**Files:**
- Modify: `src/components/RulesPage.tsx`

- [ ] **Step 1: Read the current file**

Read the existing `src/components/RulesPage.tsx` in full to avoid regressions.

- [ ] **Step 2: Add inline Try/Amend + `?ruleId&focus=autofix` handling**

Replace the component body with the following — it adds a `useSearchParams` hook, an `expandedRuleId` state, a `Try to fix all` button per rule, an inline autofix editor (pattern / replacement / flags) revealed when `Amend` is clicked or the URL requests it, and a small usage summary under the page title.

```tsx
import { useEffect, useState, useMemo } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowLeft, AlertTriangle, AlertCircle, Trash2, Wand2, ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getProject } from "@/lib/store/project-index"
import { useRules } from "@/hooks/useRules"
import { RuleCreateDialog } from "./RuleCreateDialog"
import { RuleSuggestDialog } from "./RuleSuggestDialog"
import type { ProjectRecord, RuleAutofix, TranslationRule } from "@/lib/parsers/types"

export function RulesPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)

  function refresh() {
    if (!id) return
    getProject(id).then((p) => { if (p) setProject(p) })
  }

  useEffect(() => {
    if (!id) return
    getProject(id).then((p) => {
      if (p) setProject(p)
      setLoading(false)
    })
  }, [id])

  useEffect(() => {
    const focusId = searchParams.get("ruleId")
    const focus = searchParams.get("focus")
    if (focusId && focus === "autofix" && project) {
      setExpandedRuleId(focusId)
      requestAnimationFrame(() => {
        document.getElementById(`rule-row-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      })
    }
  }, [searchParams, project])

  const { rules, penalties, addRule, updateRule, deleteRule, updatePenalties } = useRules(project, refresh)

  const usageSummary = useMemo(() => {
    const u = project?.usage
    if (!u) return null
    const calls = Object.values(u.llmCalls).reduce((s, v) => s + v.total, 0)
    return `${u.fixesApplied} fixes applied · ${calls} LLM calls this project`
  }, [project?.usage])

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  function toggleExpanded(ruleId: string) {
    setExpandedRuleId((cur) => cur === ruleId ? null : ruleId)
    const next = new URLSearchParams(searchParams)
    if (next.get("ruleId") === ruleId) next.delete("ruleId"); else next.set("ruleId", ruleId)
    next.delete("focus")
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Translation Rules</h2>
        <div className="flex-1" />
        <RuleSuggestDialog files={project?.files || []} completionSettings={project?.completionSettings} onAdd={addRule} />
        <RuleCreateDialog onAdd={addRule} />
      </header>

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        {usageSummary && (
          <p className="text-xs text-muted-foreground" title="LLM usage on this project">{usageSummary}</p>
        )}

        <Card>
          <CardHeader><CardTitle>Penalty Configuration</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="majpen">Major penalty (health points)</Label>
                <Input id="majpen" type="number" value={penalties.major}
                  onChange={(e) => updatePenalties({ ...penalties, major: Number(e.target.value) })} />
              </div>
              <div>
                <Label htmlFor="minpen">Minor penalty (health points)</Label>
                <Input id="minpen" type="number" value={penalties.minor}
                  onChange={(e) => updatePenalties({ ...penalties, minor: Number(e.target.value) })} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Rules ({rules.length})</CardTitle></CardHeader>
          <CardContent>
            {rules.length === 0 ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>No rules defined yet.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {rules.map((rule) => {
                  const Icon = rule.severity === "major" ? AlertTriangle : AlertCircle
                  const badgeColor = rule.severity === "major"
                    ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                  const expanded = expandedRuleId === rule.id
                  return (
                    <li key={rule.id} id={`rule-row-${rule.id}`} className="rounded border p-3">
                      <div className="flex items-center gap-3">
                        <Icon className={`h-4 w-4 flex-shrink-0 ${rule.severity === "major" ? "text-red-500" : "text-amber-500"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{rule.name}</span>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor}`}>{rule.severity}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{rule.source}</span>
                            {rule.autofix && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">autofix</span>}
                          </div>
                          {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                        </div>
                        <Button size="sm" variant="outline" onClick={() => navigate(`/project/${id}?openRule=${rule.id}`)} title="Opens the editor with this rule's drawer">
                          <Wand2 className="mr-1 h-3.5 w-3.5" />
                          Try to fix all
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => toggleExpanded(rule.id)}>
                          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </Button>
                        <label className="flex items-center gap-1 text-xs">
                          <input type="checkbox" checked={rule.enabled}
                            onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })} />
                          <span className="text-muted-foreground">Enabled</span>
                        </label>
                        <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>

                      {expanded && (
                        <AutofixEditor rule={rule} onUpdate={(af) => updateRule(rule.id, { autofix: af })} />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

function AutofixEditor({ rule, onUpdate }: { rule: TranslationRule; onUpdate: (af: RuleAutofix | undefined) => void }) {
  const [pattern, setPattern] = useState(rule.autofix?.pattern ?? "")
  const [replacement, setReplacement] = useState(rule.autofix?.replacement ?? "")
  const [flags, setFlags] = useState(rule.autofix?.flags ?? "gi")

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Saved autofix (regex)</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input data-autofix-field="pattern" placeholder="Pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <Input placeholder="Replacement" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
        <Input placeholder="Flags (e.g. gi)" value={flags} onChange={(e) => setFlags(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onUpdate(pattern ? { kind: "regex-replace", pattern, replacement, flags } : undefined)}>
          Save autofix
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onUpdate(undefined)}>Clear</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/RulesPage.tsx
git commit -m "feat(autofix): rules page inline autofix editor + usage summary"
```

---

## Task 12: `?openRule=X` support in ProjectWorkspace

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx`

The rules page's "Try to fix all" button navigates back to the editor with `?openRule=<id>` so the `RuleDrawer` auto-opens. Wire that.

- [ ] **Step 1: Read the workspace file**

Read `src/components/ProjectWorkspace.tsx` around the `drawerRuleId` state and the `useSearchParams` import (if absent, import it from `react-router-dom`).

- [ ] **Step 2: Add the effect**

Just after the `drawerRuleId` state declaration, add:

```tsx
const [searchParams] = useSearchParams()
useEffect(() => {
  const open = searchParams.get("openRule")
  if (open) setDrawerRuleId(open)
}, [searchParams])
```

Ensure `useSearchParams` and `useEffect` are imported from `react-router-dom` / `react`.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProjectWorkspace.tsx
git commit -m "feat(autofix): open RuleDrawer via ?openRule= query param"
```

---

## Task 13: Retrofit `rule-suggester` call sites to pass usage callback

**Files:**
- Modify: `src/components/RuleSuggestDialog.tsx`

- [ ] **Step 1: Read the file**

Read `src/components/RuleSuggestDialog.tsx` to find where `suggestRulesFromPairs` is called.

- [ ] **Step 2: Add the onLlmCall argument**

Find the call to `suggestRulesFromPairs(...)` and add a fourth argument that calls `addLlmCall` via `updateProject`. If the dialog receives the project via props or a refresh hook, pass a callback that:
1. Gets the current project.
2. Calls `addLlmCall(project, meta)`.
3. Persists via `updateProject`.

Add the following near the top of the file:

```tsx
import { addLlmCall } from "@/lib/usage/record-usage"
import { getProject, updateProject } from "@/lib/store/project-index"
```

And pass the callback to `suggestRulesFromPairs`:

```tsx
await suggestRulesFromPairs(
  pairs,
  completionSettings!,
  session,
  async (meta) => {
    if (!projectId) return
    const current = await getProject(projectId)
    if (!current) return
    await updateProject(addLlmCall(current, meta))
  },
)
```

If `projectId` is not available in the component's props, thread it down from `RulesPage.tsx` by adding a `projectId={id}` prop to `<RuleSuggestDialog>`.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/RuleSuggestDialog.tsx src/components/RulesPage.tsx
git commit -m "feat(usage): track rule-suggestion LLM calls from RuleSuggestDialog"
```

---

## Task 14: Manual verification

- [ ] **Step 1: Start dev server**

Run: `npm run dev`
Open the app in a browser.

- [ ] **Step 2: Regex-amenable rule end-to-end**

1. Open a project with at least 5 translated cells.
2. Add a rule via the Rules page: `target-forbids` with pattern `foo`.
3. Edit a few cells to contain "foo" (wait for infractions to appear).
4. In the editor, click the rule badge to open `RuleDrawer`.
5. Click "Try to fix all" — the review panel opens with 3+ previews, all pre-checked, mode badge "Batch regex".
6. Uncheck one, then click "Apply N selected".
7. Verify the affected cells now show the replacement. Verify the drawer refreshes and the fixed cells move from Breaking to Following.
8. Verify `rule.autofix` is persisted: close the drawer, reopen — the subtle "Saved autofix" label shows the regex.
9. Verify counters incremented: go to Rules page, usage summary shows `1 fix applied · N LLM calls`.
10. Cell history for one of the fixed cells shows an `llm` entry with author `autofix:rule-<id>`.

- [ ] **Step 3: Cached regex path**

1. Add another violating cell after the first apply.
2. Open the rule drawer and click "Try to fix all" — mode badge should be "Cached regex" and no LLM call should fire (observe network tab or check that `llmCalls` did not increment).

- [ ] **Step 4: Semantic fallback**

1. Create a rule that cannot be expressed with a single regex fix — e.g., `target-forbids` with a pattern flagging multiple distinct offensive words. Seed <10 violations.
2. Click "Try to fix all". If attempt 1 returns `kind: "none"`, attempt 2 runs per-cell and the mode badge shows "Per-cell rewrite".

- [ ] **Step 5: Failure state**

1. Create a rule so abstract the LLM can't auto-fix it and keep >=10 violations.
2. Click "Try to fix all". Panel opens with the LLM's reason and an "Amend rule" button. Clicking amend navigates to `/project/:id/rules?ruleId=<id>&focus=autofix` with the editor expanded and pattern field reachable.

- [ ] **Step 6: Surgical sparkle**

1. In the drawer, click the sparkle icon on a violating row. A per-cell review panel opens with one preview; Apply updates just that cell; counter increments by 1.

- [ ] **Step 7: Rules page → back to editor**

1. On the Rules page, click "Try to fix all" on a rule. Editor opens with `?openRule=<id>`; drawer auto-opens for that rule.

- [ ] **Step 8: Commit checkpoint**

```bash
git commit --allow-empty -m "verify(autofix): manual end-to-end checks passed"
```

---

## Out-of-scope reminders

- No server-side counters.
- No automatic application of fixes.
- No per-rule count UI beyond the `autofix` badge chip — derive from cell history if needed later.
- No organization-shared autofix library.
