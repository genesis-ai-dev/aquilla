# LQA Hot-Tier Algorithmic Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 9 universal, language-agnostic per-cell LQA checks that run on every keystroke through the existing rule engine, with a "Built-in checks" UI in RulesPage that lets users toggle and adjust severity per-project. Zero user setup required.

**Architecture:** Each check is a pure function `(source, target) => InfractionSpan[] | null` in `src/lib/lqa/check-functions/`. A registry maps each `BuiltinCheckId` to its function + display metadata + defaults. A new `RuleCheck` variant `{ type: "builtin"; checkId }` lets the existing rule engine dispatch into the registry — built-ins flow through the same severity, autofix, waiver, infraction-display infrastructure as user rules. `useRules` merges synthetic built-in rules (materialized from `ProjectRecord.algorithmicChecks` overrides + defaults) into the rule list before handing it to the health engine.

**Tech Stack:** TypeScript, Vitest, React, existing rule engine (`src/lib/rules/rule-engine.ts`), existing health engine (`src/workers/health-worker-sync.ts`).

**Spec:** [docs/superpowers/specs/2026-04-30-lqa-quality-checks-design.md](../specs/2026-04-30-lqa-quality-checks-design.md)

**Out of scope (covered by Plan B & C):** cross-cell checks (duplicate-target, inconsistent-translation, length-ratio, script-leakage, wrong-language-detected, segment-count), glossary, do-not-translate.

---

## File Structure

**Created:**
- `src/lib/lqa/check-functions/empty-target.ts` + `.test.ts`
- `src/lib/lqa/check-functions/target-equals-source.ts` + `.test.ts`
- `src/lib/lqa/check-functions/placeholder-integrity.ts` + `.test.ts`
- `src/lib/lqa/check-functions/number-integrity.ts` + `.test.ts`
- `src/lib/lqa/check-functions/end-punctuation-mismatch.ts` + `.test.ts`
- `src/lib/lqa/check-functions/double-space.ts` + `.test.ts`
- `src/lib/lqa/check-functions/repeated-word.ts` + `.test.ts`
- `src/lib/lqa/check-functions/unpaired-symbols.ts` + `.test.ts`
- `src/lib/lqa/check-functions/abbreviation-mismatch.ts` + `.test.ts`
- `src/lib/lqa/builtin-registry.ts` + `.test.ts`
- `src/lib/lqa/builtin-resolver.ts` + `.test.ts`
- `src/components/BuiltinChecksList.tsx` + `.test.tsx`

**Modified:**
- `src/lib/parsers/types.ts` — add `BuiltinCheckId`, extend `RuleCheck` union, add `algorithmicChecks` field on `ProjectRecord`
- `src/lib/rules/rule-engine.ts` — handle `"builtin"` check variant; split empty-aware vs regular checks
- `src/hooks/useRules.ts` — merge built-in rules into returned `rules`; expose `setBuiltinOverride`
- `src/components/RulesPage.tsx` — render `<BuiltinChecksList>` above existing user-rule list

**Naming convention:** every file under `src/lib/lqa/check-functions/` exports a single named function `runCheck` returning `InfractionSpan[] | null` (`null` = clean) plus a `MESSAGE` template string. The registry imports both.

---

## Tasks

### Task 1: Add foundation types

**Files:**
- Modify: `src/lib/parsers/types.ts`

- [ ] **Step 1: Add `BuiltinCheckId` union and `algorithmicChecks` field**

In `src/lib/parsers/types.ts`, add **above** the `TranslationRule` interface:

```typescript
export type BuiltinCheckId =
  | "empty-target"
  | "target-equals-source"
  | "placeholder-integrity"
  | "number-integrity"
  | "end-punctuation-mismatch"
  | "double-space"
  | "repeated-word"
  | "unpaired-symbols"
  | "abbreviation-mismatch"

export interface AlgorithmicCheckOverride {
  enabled: boolean
  /** Omit to use the registry default. */
  severity?: "major" | "minor"
}
```

Extend the `RuleCheck` union (currently three variants) with a fourth:

```typescript
export type RuleCheck =
  | { type: "source-requires-target"; sourcePattern: string; targetPattern: string }
  | { type: "target-forbids"; targetPattern: string }
  | { type: "source-target-match"; pattern: string }
  | { type: "builtin"; checkId: BuiltinCheckId }
```

Add a field to `ProjectRecord` (alongside `rules?: TranslationRule[]`):

```typescript
  /** Per-project enable/severity overrides for built-in algorithmic checks.
   *  Absent → registry defaults apply. */
  algorithmicChecks?: Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/parsers/types.ts
git commit -m "feat(lqa): add BuiltinCheckId types and algorithmicChecks field"
```

---

### Task 2: Implement `empty-target` check

**Files:**
- Create: `src/lib/lqa/check-functions/empty-target.ts`
- Test: `src/lib/lqa/check-functions/empty-target.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/lqa/check-functions/empty-target.test.ts
import { describe, it, expect } from "vitest"
import { runCheck } from "./empty-target"

describe("empty-target", () => {
  it("flags non-empty source with empty target", () => {
    expect(runCheck("Hello world", "")).not.toBeNull()
  })

  it("flags non-empty source with whitespace-only target", () => {
    expect(runCheck("Hello world", "   \n\t")).not.toBeNull()
  })

  it("does not flag when both source and target are empty", () => {
    expect(runCheck("", "")).toBeNull()
  })

  it("does not flag when target has content", () => {
    expect(runCheck("Hello", "Bonjour")).toBeNull()
  })

  it("returns a target span covering the cell", () => {
    const spans = runCheck("Hello", "")
    expect(spans).toEqual([{ side: "target", start: 0, end: 0, matchedText: "" }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/empty-target.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/empty-target.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Source has content but the translation is empty"

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  if (source.trim() === "") return null
  if (target.trim() !== "") return null
  return [{ side: "target", start: 0, end: 0, matchedText: "" }]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/empty-target.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/empty-target.ts src/lib/lqa/check-functions/empty-target.test.ts
git commit -m "feat(lqa): empty-target check"
```

---

### Task 3: Implement `target-equals-source` check

**Files:**
- Create: `src/lib/lqa/check-functions/target-equals-source.ts`
- Test: `src/lib/lqa/check-functions/target-equals-source.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck } from "./target-equals-source"

describe("target-equals-source", () => {
  it("flags target identical to source", () => {
    expect(runCheck("Hello world", "Hello world")).not.toBeNull()
  })

  it("flags after trimming whitespace differences", () => {
    expect(runCheck("Hello", "  Hello  ")).not.toBeNull()
  })

  it("does not flag different texts", () => {
    expect(runCheck("Hello", "Bonjour")).toBeNull()
  })

  it("does not flag short source (<= 3 chars) — likely a proper noun", () => {
    expect(runCheck("USA", "USA")).toBeNull()
  })

  it("does not flag empty cells", () => {
    expect(runCheck("", "")).toBeNull()
    expect(runCheck("Hello", "")).toBeNull()
  })

  it("returns a target span covering the whole target", () => {
    const spans = runCheck("Hello world", "Hello world")
    expect(spans).toEqual([{ side: "target", start: 0, end: 11, matchedText: "Hello world" }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/target-equals-source.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/target-equals-source.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Translation is identical to the source"

const MIN_LENGTH = 4

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const s = source.trim()
  const t = target.trim()
  if (s.length < MIN_LENGTH || t.length < MIN_LENGTH) return null
  if (s !== t) return null
  return [{ side: "target", start: 0, end: target.length, matchedText: target }]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/target-equals-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/target-equals-source.ts src/lib/lqa/check-functions/target-equals-source.test.ts
git commit -m "feat(lqa): target-equals-source check"
```

---

### Task 4: Implement `placeholder-integrity` check

**Files:**
- Create: `src/lib/lqa/check-functions/placeholder-integrity.ts`
- Test: `src/lib/lqa/check-functions/placeholder-integrity.test.ts`

Detects: `{name}`, `<tag>`, `%s`, `%1$s`, `\n`, `\t`, `&amp;`-style HTML entities. Source-extracted tokens must be present in target.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck, extractPlaceholders } from "./placeholder-integrity"

describe("extractPlaceholders", () => {
  it("extracts curly placeholders", () => {
    expect(extractPlaceholders("Hello {name}, you have {count} messages"))
      .toEqual(["{name}", "{count}"])
  })
  it("extracts angle tags", () => {
    expect(extractPlaceholders("Click <a>here</a> to <b>continue</b>"))
      .toEqual(["<a>", "</a>", "<b>", "</b>"])
  })
  it("extracts printf-style", () => {
    expect(extractPlaceholders("%s found %d items, %1$s vs %2$s"))
      .toEqual(["%s", "%d", "%1$s", "%2$s"])
  })
  it("extracts escape sequences", () => {
    expect(extractPlaceholders("Line1\\nLine2\\tTabbed")).toEqual(["\\n", "\\t"])
  })
  it("extracts HTML entities", () => {
    expect(extractPlaceholders("Tom &amp; Jerry &nbsp;here")).toEqual(["&amp;", "&nbsp;"])
  })
})

describe("placeholder-integrity", () => {
  it("returns null when target contains all source placeholders", () => {
    expect(runCheck("Hello {name}", "Bonjour {name}")).toBeNull()
  })

  it("flags missing placeholder", () => {
    const spans = runCheck("Hello {name}, age {age}", "Bonjour {name}")
    expect(spans).not.toBeNull()
    expect(spans!.length).toBe(1)
    expect(spans![0].side).toBe("source")
    expect(spans![0].matchedText).toBe("{age}")
  })

  it("flags missing tag", () => {
    expect(runCheck("Click <a>here</a>", "Cliquez ici")).not.toBeNull()
  })

  it("returns null when source has no placeholders", () => {
    expect(runCheck("Plain text", "Texte simple")).toBeNull()
  })

  it("does not flag duplicates as missing", () => {
    expect(runCheck("{x} {x}", "{x} {x}")).toBeNull()
    expect(runCheck("{x} {x}", "{x}")).toBeNull() // count mismatch tolerated in v1
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/placeholder-integrity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/placeholder-integrity.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Placeholder missing in translation"

// Order matters: longer patterns first so e.g. %1$s isn't shadowed by %s.
// Keep these alternations narrow — broad patterns produce false positives.
const PLACEHOLDER_RE = new RegExp(
  [
    "%\\d+\\$[sdif]",     // %1$s, %2$d
    "%[sdif]",            // %s, %d, %i, %f
    "\\\\[nrt]",          // \n \r \t
    "&[a-z]+;",           // &amp; &nbsp;
    "</?[a-zA-Z][^>]*>",  // <tag> </tag> <tag attr="x">
    "\\{[^}\\s]+\\}",     // {name}
  ].join("|"),
  "g",
)

export function extractPlaceholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) out.push(m[0])
  return out
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sourcePlaceholders = extractPlaceholders(source)
  if (sourcePlaceholders.length === 0) return null

  const seen = new Set(extractPlaceholders(target))
  const missing: InfractionSpan[] = []

  // Walk source again to capture span offsets for missing tokens.
  for (const m of source.matchAll(PLACEHOLDER_RE)) {
    if (m.index === undefined) continue
    if (!seen.has(m[0])) {
      missing.push({
        side: "source",
        start: m.index,
        end: m.index + m[0].length,
        matchedText: m[0],
      })
    }
  }

  return missing.length > 0 ? missing : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/placeholder-integrity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/placeholder-integrity.ts src/lib/lqa/check-functions/placeholder-integrity.test.ts
git commit -m "feat(lqa): placeholder-integrity check"
```

---

### Task 5: Implement `number-integrity` check

**Files:**
- Create: `src/lib/lqa/check-functions/number-integrity.ts`
- Test: `src/lib/lqa/check-functions/number-integrity.test.ts`

Locale-tolerant: extract digit groups from source, normalize by stripping all non-digit chars except leading `-`, compare against target's normalized digit groups.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck } from "./number-integrity"

describe("number-integrity", () => {
  it("returns null when all source numbers appear in target", () => {
    expect(runCheck("3 days, 12 hours", "trois días, 12 heures")).toBeNull()
  })

  it("tolerates locale separators (1,000 vs 1.000)", () => {
    expect(runCheck("Population: 1,000,000", "Población: 1.000.000")).toBeNull()
  })

  it("flags missing number", () => {
    const spans = runCheck("3 days, 12 hours", "trois jours")
    expect(spans).not.toBeNull()
    expect(spans!.some(s => s.matchedText === "12")).toBe(true)
  })

  it("returns null when source has no numbers", () => {
    expect(runCheck("Hello world", "Bonjour")).toBeNull()
  })

  it("matches negative numbers", () => {
    expect(runCheck("Drop of -5 degrees", "Caída de -5 grados")).toBeNull()
    expect(runCheck("Drop of -5 degrees", "Caída de 5 grados")).not.toBeNull()
  })

  it("does not double-count duplicates", () => {
    expect(runCheck("5 and 5", "cinco y 5")).toBeNull() // one '5' in target satisfies all
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/number-integrity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/number-integrity.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Number from source missing in translation"

// Match optional minus, then digit groups optionally separated by , or .
const NUMBER_RE = /-?\d+(?:[.,]\d+)*/g

/** Strip locale separators down to a canonical digit-only form (preserving the minus sign). */
function canonicalize(raw: string): string {
  if (raw.startsWith("-")) return "-" + raw.slice(1).replace(/[^0-9]/g, "")
  return raw.replace(/[^0-9]/g, "")
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sourceMatches = [...source.matchAll(NUMBER_RE)]
  if (sourceMatches.length === 0) return null

  const targetCanonical = new Set(
    [...target.matchAll(NUMBER_RE)].map((m) => canonicalize(m[0])),
  )

  const missing: InfractionSpan[] = []
  for (const m of sourceMatches) {
    if (m.index === undefined) continue
    const canon = canonicalize(m[0])
    if (!targetCanonical.has(canon)) {
      missing.push({
        side: "source",
        start: m.index,
        end: m.index + m[0].length,
        matchedText: m[0],
      })
    }
  }

  return missing.length > 0 ? missing : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/number-integrity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/number-integrity.ts src/lib/lqa/check-functions/number-integrity.test.ts
git commit -m "feat(lqa): number-integrity check"
```

---

### Task 6: Implement `end-punctuation-mismatch` check

**Files:**
- Create: `src/lib/lqa/check-functions/end-punctuation-mismatch.ts`
- Test: `src/lib/lqa/check-functions/end-punctuation-mismatch.test.ts`

Source ends with `?` / `!` / `.` (or locale equivalents) → target must end the same class. Trims trailing whitespace and bidi marks before checking.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck } from "./end-punctuation-mismatch"

describe("end-punctuation-mismatch", () => {
  it("returns null when both end with question mark", () => {
    expect(runCheck("Where are you?", "¿Dónde estás?")).toBeNull()
  })

  it("returns null when both end with exclamation", () => {
    expect(runCheck("Stop!", "¡Detente!")).toBeNull()
  })

  it("flags source-? but target-.", () => {
    expect(runCheck("Where are you?", "Donde estas.")).not.toBeNull()
  })

  it("flags target adds ! when source has .", () => {
    expect(runCheck("He went home.", "Il est rentré!")).not.toBeNull()
  })

  it("returns null when neither has terminal punctuation", () => {
    expect(runCheck("first clause", "première clause")).toBeNull()
  })

  it("recognizes CJK terminal punctuation", () => {
    expect(runCheck("Where?", "你在哪里？")).toBeNull()
    expect(runCheck("Stop!", "停！")).toBeNull()
  })

  it("ignores trailing whitespace", () => {
    expect(runCheck("Hello?", "Bonjour?  \n")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/end-punctuation-mismatch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/end-punctuation-mismatch.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Terminal punctuation differs from source"

// Strip trailing whitespace and bidi/format marks before classifying.
const TRAILING_NOISE_RE = /[\s‎‏‪-‮⁦-⁩]+$/

type EndClass = "question" | "exclamation" | "statement" | "none"

const QUESTION_CHARS = new Set(["?", "？", "؟"])
const EXCLAMATION_CHARS = new Set(["!", "！", "¡"])
const STATEMENT_CHARS = new Set([".", "。", "…", "．"])

function classify(text: string): EndClass {
  const trimmed = text.replace(TRAILING_NOISE_RE, "")
  if (trimmed.length === 0) return "none"
  const last = trimmed[trimmed.length - 1]
  if (QUESTION_CHARS.has(last)) return "question"
  if (EXCLAMATION_CHARS.has(last)) return "exclamation"
  if (STATEMENT_CHARS.has(last)) return "statement"
  return "none"
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sc = classify(source)
  const tc = classify(target)
  if (sc === tc) return null
  // Only flag when source has a definite terminal class — avoid noise on
  // partial sentences where neither side is punctuated.
  if (sc === "none") return null
  // Span the last visible char of target (or a zero-width span at end if empty).
  const trimmed = target.replace(TRAILING_NOISE_RE, "")
  const end = trimmed.length
  const start = Math.max(0, end - 1)
  return [{
    side: "target",
    start,
    end,
    matchedText: trimmed.slice(start, end),
  }]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/end-punctuation-mismatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/end-punctuation-mismatch.ts src/lib/lqa/check-functions/end-punctuation-mismatch.test.ts
git commit -m "feat(lqa): end-punctuation-mismatch check"
```

---

### Task 7: Implement `double-space` check

**Files:**
- Create: `src/lib/lqa/check-functions/double-space.ts`
- Test: `src/lib/lqa/check-functions/double-space.test.ts`

Suppress when source has the same pattern (intentional formatting).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck } from "./double-space"

describe("double-space", () => {
  it("flags consecutive spaces", () => {
    const spans = runCheck("Hello world", "Bonjour  monde")
    expect(spans).not.toBeNull()
    expect(spans![0].matchedText).toBe("  ")
  })

  it("flags leading whitespace", () => {
    expect(runCheck("Hello", " Bonjour")).not.toBeNull()
  })

  it("flags trailing whitespace", () => {
    expect(runCheck("Hello", "Bonjour ")).not.toBeNull()
  })

  it("returns null when source has matching double space (intentional)", () => {
    expect(runCheck("col1  col2", "col1  col2")).toBeNull()
  })

  it("returns null on clean target", () => {
    expect(runCheck("Hello world", "Bonjour monde")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/double-space.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/double-space.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Extra whitespace in translation"

const DOUBLE_SPACE_RE = / {2,}/g
const LEADING_RE = /^\s+/
const TRAILING_RE = /\s+$/

function findAll(text: string): { start: number; end: number; matchedText: string }[] {
  const out: { start: number; end: number; matchedText: string }[] = []
  for (const m of text.matchAll(DOUBLE_SPACE_RE)) {
    if (m.index === undefined) continue
    out.push({ start: m.index, end: m.index + m[0].length, matchedText: m[0] })
  }
  const lead = text.match(LEADING_RE)
  if (lead) out.unshift({ start: 0, end: lead[0].length, matchedText: lead[0] })
  const trail = text.match(TRAILING_RE)
  if (trail) {
    const start = text.length - trail[0].length
    out.push({ start, end: text.length, matchedText: trail[0] })
  }
  return out
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetHits = findAll(target)
  if (targetHits.length === 0) return null

  // Suppress hits that exactly mirror a source occurrence at the same relative
  // position. Cheap heuristic: if source has the same multiset of widths, skip.
  const sourceWidths = findAll(source).map((h) => h.matchedText.length).sort()
  const targetWidths = targetHits.map((h) => h.matchedText.length).sort()
  if (sourceWidths.length === targetWidths.length
      && sourceWidths.every((w, i) => w === targetWidths[i])) {
    return null
  }

  return targetHits.map((h) => ({
    side: "target" as const,
    start: h.start,
    end: h.end,
    matchedText: h.matchedText,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/double-space.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/double-space.ts src/lib/lqa/check-functions/double-space.test.ts
git commit -m "feat(lqa): double-space check"
```

---

### Task 8: Implement `repeated-word` check

**Files:**
- Create: `src/lib/lqa/check-functions/repeated-word.ts`
- Test: `src/lib/lqa/check-functions/repeated-word.test.ts`

Flag adjacent identical word tokens (case-insensitive). Suppress when the source has the same repetition.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck } from "./repeated-word"

describe("repeated-word", () => {
  it("flags repeated adjacent word", () => {
    const spans = runCheck("This is a test", "This is is a test")
    expect(spans).not.toBeNull()
    expect(spans![0].matchedText.toLowerCase()).toContain("is")
  })

  it("is case-insensitive", () => {
    expect(runCheck("Hello", "Hello hello")).not.toBeNull()
  })

  it("suppresses when source has same repetition (genuine repetition)", () => {
    expect(runCheck("Holy holy holy is the Lord", "Saint saint saint est le Seigneur")).toBeNull()
  })

  it("returns null on clean target", () => {
    expect(runCheck("Hello world", "Bonjour monde")).toBeNull()
  })

  it("only flags whole-token matches, not substrings", () => {
    expect(runCheck("Test", "Testing tester")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/repeated-word.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/repeated-word.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Word repeated in translation"

// Capture word + the whitespace + same word, with index. Unicode-aware via \p{L}.
const REPEAT_RE = /(\p{L}+)(\s+)(\1)(?=\s|$|\p{P})/giu

function countRepetitions(text: string): number {
  let count = 0
  for (const _ of text.matchAll(REPEAT_RE)) count++
  return count
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetHits: InfractionSpan[] = []
  for (const m of target.matchAll(REPEAT_RE)) {
    if (m.index === undefined) continue
    const start = m.index
    const end = start + m[0].length
    targetHits.push({ side: "target", start, end, matchedText: m[0] })
  }
  if (targetHits.length === 0) return null

  // Suppress when source has at least as many repetitions — likely intentional.
  if (countRepetitions(source) >= targetHits.length) return null

  return targetHits
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/repeated-word.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/repeated-word.ts src/lib/lqa/check-functions/repeated-word.test.ts
git commit -m "feat(lqa): repeated-word check"
```

---

### Task 9: Implement `unpaired-symbols` check

**Files:**
- Create: `src/lib/lqa/check-functions/unpaired-symbols.ts`
- Test: `src/lib/lqa/check-functions/unpaired-symbols.test.ts`

Counts brackets/parens/braces. Flags imbalance unless the source has the same imbalance.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck } from "./unpaired-symbols"

describe("unpaired-symbols", () => {
  it("flags missing closing paren", () => {
    expect(runCheck("Note (see ref) here", "Note (voir réf ici")).not.toBeNull()
  })

  it("flags missing opening bracket", () => {
    expect(runCheck("Edit [draft]", "Modifier draft]")).not.toBeNull()
  })

  it("returns null when balanced", () => {
    expect(runCheck("Note (see ref)", "Note (voir réf)")).toBeNull()
  })

  it("suppresses when source has same imbalance", () => {
    expect(runCheck("partial (no close", "partiel (sans fermer")).toBeNull()
  })

  it("returns null when no symbols", () => {
    expect(runCheck("Hello", "Bonjour")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/unpaired-symbols.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/unpaired-symbols.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Unpaired bracket/parenthesis/brace in translation"

const PAIRS: Array<readonly [open: string, close: string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]

interface Imbalance { open: number; close: number }

function tally(text: string): Map<string, Imbalance> {
  const m = new Map<string, Imbalance>()
  for (const [o, c] of PAIRS) m.set(o + c, { open: 0, close: 0 })
  for (const ch of text) {
    for (const [o, c] of PAIRS) {
      if (ch === o) m.get(o + c)!.open++
      else if (ch === c) m.get(o + c)!.close++
    }
  }
  return m
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetTally = tally(target)
  const sourceTally = tally(source)

  const spans: InfractionSpan[] = []
  for (const [pair, t] of targetTally) {
    if (t.open === t.close) continue
    const s = sourceTally.get(pair)!
    const targetDiff = t.open - t.close
    const sourceDiff = s.open - s.close
    if (targetDiff === sourceDiff) continue // matching imbalance — suppress

    // Find the first occurrence of the offending char in target for the span.
    const offendingChar = targetDiff > 0 ? pair[0] : pair[1]
    const idx = target.indexOf(offendingChar)
    spans.push({
      side: "target",
      start: idx >= 0 ? idx : 0,
      end: idx >= 0 ? idx + 1 : 0,
      matchedText: offendingChar,
    })
  }
  return spans.length > 0 ? spans : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/unpaired-symbols.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/unpaired-symbols.ts src/lib/lqa/check-functions/unpaired-symbols.test.ts
git commit -m "feat(lqa): unpaired-symbols check"
```

---

### Task 10: Implement `abbreviation-mismatch` check

**Files:**
- Create: `src/lib/lqa/check-functions/abbreviation-mismatch.ts`
- Test: `src/lib/lqa/check-functions/abbreviation-mismatch.test.ts`

All-caps ASCII tokens (≥2 chars) in source must appear in target. Off by default; opt-in.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { runCheck } from "./abbreviation-mismatch"

describe("abbreviation-mismatch", () => {
  it("flags missing abbreviation", () => {
    const spans = runCheck("USA is large", "Les États-Unis sont grands")
    expect(spans).not.toBeNull()
    expect(spans![0].matchedText).toBe("USA")
  })

  it("returns null when abbreviation present", () => {
    expect(runCheck("USA is large", "USA est grand")).toBeNull()
  })

  it("ignores single-letter caps (likely sentence start)", () => {
    expect(runCheck("A house", "Une maison")).toBeNull()
  })

  it("returns null when source has no abbreviations", () => {
    expect(runCheck("Hello world", "Bonjour monde")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/check-functions/abbreviation-mismatch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/check-functions/abbreviation-mismatch.ts
import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Abbreviation from source missing in translation"

// Two or more consecutive ASCII upper-case letters; allow internal periods (U.S.A.) by collapsing.
const ABBREV_RE = /\b[A-Z]{2,}(?:\.[A-Z]+)*\b|\b[A-Z](?:\.[A-Z])+\.?\b/g

function normalize(s: string): string {
  return s.replace(/\./g, "").toUpperCase()
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sourceMatches = [...source.matchAll(ABBREV_RE)]
  if (sourceMatches.length === 0) return null

  const targetNormalized = new Set(
    [...target.matchAll(ABBREV_RE)].map((m) => normalize(m[0])),
  )

  const missing: InfractionSpan[] = []
  for (const m of sourceMatches) {
    if (m.index === undefined) continue
    if (!targetNormalized.has(normalize(m[0]))) {
      missing.push({
        side: "source",
        start: m.index,
        end: m.index + m[0].length,
        matchedText: m[0],
      })
    }
  }
  return missing.length > 0 ? missing : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/check-functions/abbreviation-mismatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/check-functions/abbreviation-mismatch.ts src/lib/lqa/check-functions/abbreviation-mismatch.test.ts
git commit -m "feat(lqa): abbreviation-mismatch check"
```

---

### Task 11: Build the registry

**Files:**
- Create: `src/lib/lqa/builtin-registry.ts`
- Test: `src/lib/lqa/builtin-registry.test.ts`

Maps each `BuiltinCheckId` to its function + display metadata + defaults. The single source of truth for built-ins.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/lqa/builtin-registry.test.ts
import { describe, it, expect } from "vitest"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

describe("builtin-registry", () => {
  it("contains all 9 v1 checks", () => {
    expect(BUILTIN_CHECK_IDS).toEqual([
      "empty-target",
      "target-equals-source",
      "placeholder-integrity",
      "number-integrity",
      "end-punctuation-mismatch",
      "double-space",
      "repeated-word",
      "unpaired-symbols",
      "abbreviation-mismatch",
    ])
  })

  it("each entry has id, name, description, defaultSeverity, defaultEnabled, run, message", () => {
    for (const id of BUILTIN_CHECK_IDS) {
      const def = BUILTIN_CHECKS[id]
      expect(def.id).toBe(id)
      expect(typeof def.name).toBe("string")
      expect(def.name.length).toBeGreaterThan(0)
      expect(typeof def.description).toBe("string")
      expect(["major", "minor"]).toContain(def.defaultSeverity)
      expect(typeof def.defaultEnabled).toBe("boolean")
      expect(typeof def.run).toBe("function")
      expect(typeof def.message).toBe("string")
    }
  })

  it("only abbreviation-mismatch is off by default", () => {
    for (const id of BUILTIN_CHECK_IDS) {
      const def = BUILTIN_CHECKS[id]
      if (id === "abbreviation-mismatch") expect(def.defaultEnabled).toBe(false)
      else expect(def.defaultEnabled).toBe(true)
    }
  })

  it("dispatches run() correctly", () => {
    expect(BUILTIN_CHECKS["empty-target"].run("hello", "")).not.toBeNull()
    expect(BUILTIN_CHECKS["empty-target"].run("hello", "world")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/builtin-registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/builtin-registry.ts
import type { BuiltinCheckId, InfractionSpan } from "@/lib/parsers/types"
import * as emptyTarget from "./check-functions/empty-target"
import * as targetEqualsSource from "./check-functions/target-equals-source"
import * as placeholderIntegrity from "./check-functions/placeholder-integrity"
import * as numberIntegrity from "./check-functions/number-integrity"
import * as endPunctuationMismatch from "./check-functions/end-punctuation-mismatch"
import * as doubleSpace from "./check-functions/double-space"
import * as repeatedWord from "./check-functions/repeated-word"
import * as unpairedSymbols from "./check-functions/unpaired-symbols"
import * as abbreviationMismatch from "./check-functions/abbreviation-mismatch"

export interface BuiltinCheckDefinition {
  id: BuiltinCheckId
  name: string
  description: string
  defaultSeverity: "major" | "minor"
  defaultEnabled: boolean
  /** True if the check should run even when target is empty. */
  runsOnEmptyTarget: boolean
  run: (source: string, target: string) => InfractionSpan[] | null
  message: string
}

export const BUILTIN_CHECKS: Record<BuiltinCheckId, BuiltinCheckDefinition> = {
  "empty-target": {
    id: "empty-target",
    name: "Empty translation",
    description: "Source has content but the translation is blank or whitespace-only.",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: true,
    run: emptyTarget.runCheck,
    message: emptyTarget.MESSAGE,
  },
  "target-equals-source": {
    id: "target-equals-source",
    name: "Identical to source",
    description: "Translation matches the source verbatim — likely untranslated.",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: targetEqualsSource.runCheck,
    message: targetEqualsSource.MESSAGE,
  },
  "placeholder-integrity": {
    id: "placeholder-integrity",
    name: "Placeholder integrity",
    description: "Tokens like {name}, <tag>, %s, \\n in source must appear in target.",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: placeholderIntegrity.runCheck,
    message: placeholderIntegrity.MESSAGE,
  },
  "number-integrity": {
    id: "number-integrity",
    name: "Number integrity",
    description: "Numerals in source must appear in target (locale separators are tolerated).",
    defaultSeverity: "major",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: numberIntegrity.runCheck,
    message: numberIntegrity.MESSAGE,
  },
  "end-punctuation-mismatch": {
    id: "end-punctuation-mismatch",
    name: "End punctuation",
    description: "Source ends in ?/!/. — translation should end the same way.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: endPunctuationMismatch.runCheck,
    message: endPunctuationMismatch.MESSAGE,
  },
  "double-space": {
    id: "double-space",
    name: "Extra whitespace",
    description: "Multiple consecutive spaces or leading/trailing whitespace.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: doubleSpace.runCheck,
    message: doubleSpace.MESSAGE,
  },
  "repeated-word": {
    id: "repeated-word",
    name: "Repeated word",
    description: "Same word appears twice in a row, unless the source does the same.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: repeatedWord.runCheck,
    message: repeatedWord.MESSAGE,
  },
  "unpaired-symbols": {
    id: "unpaired-symbols",
    name: "Unpaired brackets",
    description: "Mismatched parentheses, brackets, or braces in translation.",
    defaultSeverity: "minor",
    defaultEnabled: true,
    runsOnEmptyTarget: false,
    run: unpairedSymbols.runCheck,
    message: unpairedSymbols.MESSAGE,
  },
  "abbreviation-mismatch": {
    id: "abbreviation-mismatch",
    name: "Abbreviation pass-through",
    description: "ALL-CAPS abbreviations from source missing in translation.",
    defaultSeverity: "minor",
    defaultEnabled: false,
    runsOnEmptyTarget: false,
    run: abbreviationMismatch.runCheck,
    message: abbreviationMismatch.MESSAGE,
  },
}

export const BUILTIN_CHECK_IDS: BuiltinCheckId[] = [
  "empty-target",
  "target-equals-source",
  "placeholder-integrity",
  "number-integrity",
  "end-punctuation-mismatch",
  "double-space",
  "repeated-word",
  "unpaired-symbols",
  "abbreviation-mismatch",
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/builtin-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/builtin-registry.ts src/lib/lqa/builtin-registry.test.ts
git commit -m "feat(lqa): built-in check registry"
```

---

### Task 12: Engine dispatch for `"builtin"` check variant

**Files:**
- Modify: `src/lib/rules/rule-engine.ts`
- Modify: `src/lib/rules/rule-engine.test.ts`

Add a `case "builtin"` to the `checkRule()` switch. Reorder `checkRulesForCell` so `runsOnEmptyTarget` checks fire before the empty-target short-circuit.

- [ ] **Step 1: Add the failing test**

Append to `src/lib/rules/rule-engine.test.ts`:

```typescript
describe("rule engine — builtin variant", () => {
  it("dispatches to BUILTIN_CHECKS for type='builtin'", () => {
    const rule = {
      id: "builtin-empty-target", name: "Empty target",
      description: "", severity: "major" as const, source: "algorithmic" as const,
      scope: "project" as const, enabled: true,
      createdAt: "2026-04-30T00:00:00Z",
      check: { type: "builtin" as const, checkId: "empty-target" as const },
    }
    const cell = {
      id: "c1", original: "Hello", originalHtml: "", translated: "",
      context: "", group: "", type: "text" as const,
      status: "empty" as const,
      validationStatus: "none" as const, activeValidators: [],
      validationHistory: [], history: [], threads: [], fileId: "f1",
    }
    // Must produce an infraction even though target is empty.
    const out = checkRulesForCell(cell, "f1", [rule])
    expect(out.length).toBe(1)
    expect(out[0].ruleId).toBe("builtin-empty-target")
  })

  it("non-empty-aware builtins skip empty cells", () => {
    const rule = {
      id: "builtin-tes", name: "Target eq source",
      description: "", severity: "major" as const, source: "algorithmic" as const,
      scope: "project" as const, enabled: true,
      createdAt: "2026-04-30T00:00:00Z",
      check: { type: "builtin" as const, checkId: "target-equals-source" as const },
    }
    const cell = {
      id: "c1", original: "Hello", originalHtml: "", translated: "",
      context: "", group: "", type: "text" as const,
      status: "empty" as const,
      validationStatus: "none" as const, activeValidators: [],
      validationHistory: [], history: [], threads: [], fileId: "f1",
    }
    expect(checkRulesForCell(cell, "f1", [rule])).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts`
Expected: 2 failing tests in the new describe block.

- [ ] **Step 3: Modify the engine**

In `src/lib/rules/rule-engine.ts`, add the import at the top:

```typescript
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"
```

Replace the body of `checkRulesForCell` with:

```typescript
export function checkRulesForCell(
  cell: CellData,
  fileId: string,
  enabledRules: TranslationRule[],
): RuleInfraction[] {
  if (enabledRules.length === 0) return []
  const out: RuleInfraction[] = []

  // Step 1: empty-aware builtin checks fire even when target is empty.
  for (const rule of enabledRules) {
    if (rule.check.type !== "builtin") continue
    const def = BUILTIN_CHECKS[rule.check.checkId]
    if (!def?.runsOnEmptyTarget) continue
    const inf = checkRule(rule, cell, fileId)
    if (inf) out.push(inf)
  }

  // Step 2: short-circuit on empty target for the rest.
  if (cell.status === "empty" || !cell.translated.trim()) return out

  // Step 3: regular checks (skip the empty-aware builtins already handled).
  for (const rule of enabledRules) {
    if (rule.check.type === "builtin") {
      const def = BUILTIN_CHECKS[rule.check.checkId]
      if (def?.runsOnEmptyTarget) continue
    }
    const inf = checkRule(rule, cell, fileId)
    if (inf) out.push(inf)
  }
  return out
}
```

In the `checkRule` switch, add a new case **before** the closing `}`:

```typescript
    case "builtin": {
      const def = BUILTIN_CHECKS[check.checkId]
      if (!def) return null
      const spans = def.run(cell.original, cell.translated)
      if (!spans || spans.length === 0) return null
      return {
        ruleId: rule.id,
        cellId: cell.id,
        fileId,
        message: `"${rule.name}": ${def.message}`,
        spans,
      }
    }
```

- [ ] **Step 4: Run all rule-engine tests**

Run: `npx vitest run src/lib/rules/rule-engine.test.ts`
Expected: ALL pass (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/rule-engine.ts src/lib/rules/rule-engine.test.ts
git commit -m "feat(lqa): rule engine dispatches builtin check variant"
```

---

### Task 13: Resolver — overrides + defaults → synthetic rules

**Files:**
- Create: `src/lib/lqa/builtin-resolver.ts`
- Test: `src/lib/lqa/builtin-resolver.test.ts`

`resolveBuiltinRules(overrides)` returns a `TranslationRule[]` materialized from the registry, with `overrides` applied. Stable rule ids of the form `"builtin:<checkId>"` so React keys and dedup are deterministic.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/lqa/builtin-resolver.test.ts
import { describe, it, expect } from "vitest"
import { resolveBuiltinRules } from "./builtin-resolver"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

describe("resolveBuiltinRules", () => {
  it("returns one rule per registry entry by default", () => {
    const rules = resolveBuiltinRules(undefined)
    expect(rules.length).toBe(BUILTIN_CHECK_IDS.length)
    for (const id of BUILTIN_CHECK_IDS) {
      const r = rules.find((x) => x.id === `builtin:${id}`)
      expect(r).toBeTruthy()
      expect(r!.check).toEqual({ type: "builtin", checkId: id })
      expect(r!.enabled).toBe(BUILTIN_CHECKS[id].defaultEnabled)
      expect(r!.severity).toBe(BUILTIN_CHECKS[id].defaultSeverity)
      expect(r!.source).toBe("algorithmic")
    }
  })

  it("override flips enabled flag", () => {
    const rules = resolveBuiltinRules({
      "abbreviation-mismatch": { enabled: true },
    })
    const r = rules.find((x) => x.id === "builtin:abbreviation-mismatch")!
    expect(r.enabled).toBe(true)
  })

  it("override sets severity", () => {
    const rules = resolveBuiltinRules({
      "double-space": { enabled: true, severity: "major" },
    })
    const r = rules.find((x) => x.id === "builtin:double-space")!
    expect(r.severity).toBe("major")
  })

  it("missing override falls back to defaults", () => {
    const rules = resolveBuiltinRules({
      "double-space": { enabled: false },
    })
    const r = rules.find((x) => x.id === "builtin:end-punctuation-mismatch")!
    expect(r.enabled).toBe(BUILTIN_CHECKS["end-punctuation-mismatch"].defaultEnabled)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lqa/builtin-resolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/lqa/builtin-resolver.ts
import type {
  TranslationRule,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

const FROZEN_CREATED_AT = "1970-01-01T00:00:00.000Z"

export function resolveBuiltinRules(
  overrides: Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>> | undefined,
): TranslationRule[] {
  return BUILTIN_CHECK_IDS.map((id) => {
    const def = BUILTIN_CHECKS[id]
    const ov = overrides?.[id]
    return {
      id: `builtin:${id}`,
      name: def.name,
      description: def.description,
      severity: ov?.severity ?? def.defaultSeverity,
      source: "algorithmic",
      scope: "project",
      enabled: ov?.enabled ?? def.defaultEnabled,
      createdAt: FROZEN_CREATED_AT,
      check: { type: "builtin", checkId: id },
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lqa/builtin-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lqa/builtin-resolver.ts src/lib/lqa/builtin-resolver.test.ts
git commit -m "feat(lqa): builtin-resolver materializes synthetic rules"
```

---

### Task 14: Merge built-ins in `useRules`; expose `setBuiltinOverride`

**Files:**
- Modify: `src/hooks/useRules.ts`

Built-in synthetic rules are concatenated with user rules so the existing rule pipeline (health engine, RulesPage list, ViolationPopover) sees them transparently. `setBuiltinOverride` writes to `ProjectRecord.algorithmicChecks`.

- [ ] **Step 1: Modify the hook**

Replace `src/hooks/useRules.ts` body with:

```typescript
import { useCallback, useMemo } from "react"
import { v4 as uuid } from "uuid"
import type {
  ProjectRecord,
  TranslationRule,
  RulePenalties,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"

export function useRules(project: ProjectRecord | null, refresh: () => void) {
  const userRules = project?.rules || []
  const algorithmicChecks = project?.algorithmicChecks
  const penalties: RulePenalties = project?.rulePenalties || { major: 15, minor: 5 }

  const builtinRules = useMemo(
    () => resolveBuiltinRules(algorithmicChecks),
    [algorithmicChecks],
  )

  // Built-ins first so they appear at the top of the rule pipeline. Order
  // doesn't affect correctness (each rule is independent) but is stable.
  const rules = useMemo(
    () => [...builtinRules, ...userRules],
    [builtinRules, userRules],
  )

  const addRule = useCallback(async (rule: Omit<TranslationRule, "id" | "createdAt">) => {
    if (!project) return
    const newRule: TranslationRule = { ...rule, id: uuid(), createdAt: new Date().toISOString() }
    await patchProject(project.id, (p) => ({ ...p, rules: [...(p.rules || []), newRule] }))
    refresh()
  }, [project, refresh])

  const updateRule = useCallback(async (ruleId: string, updates: Partial<TranslationRule>) => {
    if (!project) return
    // Built-in rules update via setBuiltinOverride; reject here.
    if (ruleId.startsWith("builtin:")) return
    await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).map((r) => r.id === ruleId ? { ...r, ...updates } : r),
    }))
    refresh()
  }, [project, refresh])

  const deleteRule = useCallback(async (ruleId: string) => {
    if (!project) return
    if (ruleId.startsWith("builtin:")) return // built-ins cannot be deleted
    await patchProject(project.id, (p) => ({
      ...p,
      rules: (p.rules || []).filter((r) => r.id !== ruleId),
    }))
    refresh()
  }, [project, refresh])

  const updatePenalties = useCallback(async (newPenalties: RulePenalties) => {
    if (!project) return
    await patchProject(project.id, (p) => ({ ...p, rulePenalties: newPenalties }))
    refresh()
  }, [project, refresh])

  const setBuiltinOverride = useCallback(async (
    checkId: BuiltinCheckId,
    override: AlgorithmicCheckOverride,
  ) => {
    if (!project) return
    await patchProject(project.id, (p) => ({
      ...p,
      algorithmicChecks: { ...(p.algorithmicChecks ?? {}), [checkId]: override },
    }))
    refresh()
  }, [project, refresh])

  return {
    rules,
    userRules,
    builtinRules,
    penalties,
    addRule,
    updateRule,
    deleteRule,
    updatePenalties,
    setBuiltinOverride,
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run existing rule-related tests**

Run: `npx vitest run src/hooks/useRules src/lib/rules src/lib/lqa src/lib/health 2>&1 | tail -20`
Expected: ALL pass.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useRules.ts
git commit -m "feat(lqa): useRules merges built-in rules and exposes override setter"
```

---

### Task 15: `BuiltinChecksList` UI component

**Files:**
- Create: `src/components/BuiltinChecksList.tsx`
- Test: `src/components/BuiltinChecksList.test.tsx`

A table-style list. Each row: name + description, severity dropdown, enable toggle, current infraction count. No "delete" — built-ins can't be removed. No regex preview — they're managed.

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/BuiltinChecksList.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { BuiltinChecksList } from "./BuiltinChecksList"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"

describe("BuiltinChecksList", () => {
  const builtinRules = resolveBuiltinRules(undefined)

  it("renders all built-in checks", () => {
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={new Map()}
        onSetOverride={() => {}}
      />,
    )
    expect(screen.getByText("Empty translation")).toBeInTheDocument()
    expect(screen.getByText("Identical to source")).toBeInTheDocument()
    expect(screen.getByText("Placeholder integrity")).toBeInTheDocument()
  })

  it("calls onSetOverride when toggle clicked", () => {
    const spy = vi.fn()
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={new Map()}
        onSetOverride={spy}
      />,
    )
    // The "Abbreviation pass-through" row's toggle starts disabled (default).
    const row = screen.getByText("Abbreviation pass-through").closest("[data-testid='builtin-row']")!
    const toggle = row.querySelector("input[type='checkbox']")!
    fireEvent.click(toggle)
    expect(spy).toHaveBeenCalledWith("abbreviation-mismatch", expect.objectContaining({ enabled: true }))
  })

  it("displays infraction counts per check", () => {
    const infractions = new Map([
      ["c1", [{ ruleId: "builtin:empty-target", cellId: "c1", fileId: "f1", message: "x", spans: [] }]],
      ["c2", [{ ruleId: "builtin:empty-target", cellId: "c2", fileId: "f1", message: "x", spans: [] }]],
    ])
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={infractions}
        onSetOverride={() => {}}
      />,
    )
    const row = screen.getByText("Empty translation").closest("[data-testid='builtin-row']")!
    expect(row.textContent).toMatch(/2/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/BuiltinChecksList.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement**

```typescript
// src/components/BuiltinChecksList.tsx
import { useMemo } from "react"
import type { TranslationRule, RuleInfraction, AlgorithmicCheckOverride, BuiltinCheckId } from "@/lib/parsers/types"
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"

interface Props {
  builtinRules: TranslationRule[]
  infractions: Map<string, RuleInfraction[]>
  onSetOverride: (id: BuiltinCheckId, override: AlgorithmicCheckOverride) => void
}

export function BuiltinChecksList({ builtinRules, infractions, onSetOverride }: Props) {
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const cellInfractions of infractions.values()) {
      for (const inf of cellInfractions) {
        c.set(inf.ruleId, (c.get(inf.ruleId) ?? 0) + 1)
      }
    }
    return c
  }, [infractions])

  return (
    <div className="border rounded-md">
      <div className="px-4 py-2 border-b bg-muted/30 text-sm font-medium">
        Built-in checks
      </div>
      <ul className="divide-y">
        {builtinRules.map((rule) => {
          if (rule.check.type !== "builtin") return null
          const checkId = rule.check.checkId
          const def = BUILTIN_CHECKS[checkId]
          const count = counts.get(rule.id) ?? 0
          return (
            <li
              key={rule.id}
              data-testid="builtin-row"
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium">{def.name}</div>
                <div className="text-muted-foreground text-xs truncate">{def.description}</div>
              </div>
              {count > 0 && (
                <div className="text-xs text-muted-foreground tabular-nums">
                  {count} violation{count === 1 ? "" : "s"}
                </div>
              )}
              <select
                className="h-7 px-2 text-xs border rounded-sm bg-background"
                value={rule.severity}
                aria-label={`${def.name} severity`}
                onChange={(e) => onSetOverride(checkId, {
                  enabled: rule.enabled,
                  severity: e.target.value as "major" | "minor",
                })}
              >
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
              <input
                type="checkbox"
                checked={rule.enabled}
                aria-label={`${def.name} enabled`}
                onChange={(e) => onSetOverride(checkId, {
                  enabled: e.target.checked,
                  severity: rule.severity,
                })}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/BuiltinChecksList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/BuiltinChecksList.tsx src/components/BuiltinChecksList.test.tsx
git commit -m "feat(lqa): BuiltinChecksList UI component"
```

---

### Task 16: Mount `BuiltinChecksList` in `RulesPage`

**Files:**
- Modify: `src/components/RulesPage.tsx`

- [ ] **Step 1: Read the file to find the right insertion point**

Open `src/components/RulesPage.tsx` and locate where the existing user-rule list is rendered (the section that maps over `rules`). The new component should render directly above that section.

- [ ] **Step 2: Update the destructure and render**

Change the `useRules` destructure (around line 46) from:
```typescript
const { rules, penalties, addRule, updateRule, deleteRule, updatePenalties } = useRules(project, refresh)
```
to:
```typescript
const { rules, userRules, builtinRules, penalties, addRule, updateRule, deleteRule, updatePenalties, setBuiltinOverride } = useRules(project, refresh)
```

Add the import:
```typescript
import { BuiltinChecksList } from "./BuiltinChecksList"
```

Then, where the page currently renders the list of user rules, render `<BuiltinChecksList>` immediately above it. The list infractions come from the project's health stats — for now, pass an empty map (the count UI is purely cosmetic and degrades gracefully). A later task wires real infractions:

```tsx
<div className="space-y-4">
  <BuiltinChecksList
    builtinRules={builtinRules}
    infractions={new Map()}
    onSetOverride={setBuiltinOverride}
  />
  {/* existing user-rules section follows */}
  {userRules.map(rule => /* existing rendering using `rule` */)}
</div>
```

**Important:** the existing user-rule section currently iterates over `rules` (the merged array). Change it to iterate over `userRules` so built-ins don't double-render. Search for `rules.map` or `rules.filter` inside `RulesPage.tsx` and replace with `userRules` where the intent is "user-defined rules only" (e.g., the list rendering, the empty-state check, the count badge).

- [ ] **Step 3: Type-check and run tests**

Run: `npx tsc --noEmit && npx vitest run src/components/RulesPage 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 4: Smoke test in dev**

Start the project's dev server (typical command: `npm run dev`).

Open `RulesPage` for a project. Expected: a "Built-in checks" panel appears above the user-rule list with all 9 entries; toggling one persists across reload.

- [ ] **Step 5: Commit**

```bash
git add src/components/RulesPage.tsx
git commit -m "feat(lqa): render BuiltinChecksList in RulesPage"
```

---

### Task 17: Wire infraction counts in `BuiltinChecksList`

**Files:**
- Modify: `src/components/RulesPage.tsx`

The `BuiltinChecksList` accepts `infractions: Map<string, RuleInfraction[]>` — Task 16 passes `new Map()`. This task wires real infractions through.

- [ ] **Step 1: Find the source of project infractions**

In `RulesPage.tsx`, search for where infractions (or health stats) are accessed. If the page already has a `useHealth` or `useCompositeHealth` call, use its `infractions` map. If not, the simplest hop is the `useFileCells` + `useHealth` combo used by `ProjectWorkspace.tsx` — adapt the same pattern. Acceptable shortcut: a hook `useProjectInfractions(projectId)` that internally loads cells once and returns the infraction map.

If neither path exists cheaply, **defer this task to Plan B** (Plan B already needs to set up the worker dispatch from RulesPage). Mark Task 17 as deferred with a TODO comment in `RulesPage.tsx`:

```tsx
{/* TODO(lqa-plan-b): wire real infractions when worker dispatch lands. */}
<BuiltinChecksList
  builtinRules={builtinRules}
  infractions={new Map()}
  onSetOverride={setBuiltinOverride}
/>
```

- [ ] **Step 2: If wiring is feasible, implement and verify counts update**

Otherwise commit the TODO and move on. Either way:

```bash
git add src/components/RulesPage.tsx
git commit -m "feat(lqa): wire (or defer) infraction counts on built-in checks"
```

---

### Task 18: Final verification

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run 2>&1 | tail -30`
Expected: ALL pass.

- [ ] **Step 3: Targeted LQA-folder coverage**

Run: `npx vitest run src/lib/lqa src/lib/rules src/components/BuiltinChecksList 2>&1 | tail -15`
Expected: ALL pass.

- [ ] **Step 4: Manual smoke test**

Open the dev server, create or open a project, edit a cell so each of the 9 checks triggers at least once. Verify:
- Each infraction shows up in the editor (existing `ViolationPopover` infrastructure)
- `RulesPage` "Built-in checks" panel shows non-zero counts (if Task 17 wired) or zero (if deferred)
- Disabling a check clears its infractions on next health recompute
- Severity dropdown change updates health penalty math

- [ ] **Step 5: Final commit (if any pending)**

```bash
git status
# ensure clean
```

If anything's untracked, decide whether to commit and do so with a descriptive message.

---

## Self-Review Notes

- **Spec coverage:**
  - 9 hot-tier algorithmic checks: ✅ Tasks 2-10
  - `algorithmicChecks` overrides + defaults: ✅ Tasks 1, 13
  - Engine dispatch with empty-aware ordering: ✅ Task 12
  - RulesPage UI: ✅ Tasks 15, 16
  - Glossary, DNT, cross-cell, worker: ❌ deferred to Plans B & C (explicit)
  - Performance budget profiling: ⚠️ visual confirmation in Task 18 step 4 only; CI bench is part of Plan B (touches the worker)
- **Type consistency:** `BuiltinCheckId` and `AlgorithmicCheckOverride` flow through tasks 1 → 11 → 13 → 14 → 15 with the same names. `runCheck` and `MESSAGE` are the consistent export names across all 9 check files.
- **Placeholder scan:** all code blocks are complete. The only "decide later" is Task 17, which is explicitly conditional with a documented fallback.

## Plan A acceptance

When all tasks ship:
- A new project with no setup gets 8 of 9 algorithmic checks running on every keystroke (abbreviation-mismatch off-by-default).
- Users can toggle/sever any built-in from `RulesPage`.
- Built-in violations contribute to health exactly like user rules.
- Hot-path latency: no new regex compilation per call (existing cache); per-cell work is the same shape as before. Profile in Plan B benchmark.

## Next plans

- **Plan B** — extend `health-worker-sync.ts` with cross-cell indices and 6 idle-tier checks (duplicate-target, inconsistent-translation, length-ratio, script-leakage, segment-count, wrong-language-detected).
- **Plan C** — Glossary + DNT data model, Settings → Glossary page, runtime compilation into `source-requires-target` rules, CSV import.
