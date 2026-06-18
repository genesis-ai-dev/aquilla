# Translation Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a skopos/Paratext-based Translation Brief to each project — authored via a code-owned structured interview with LLM drafting help, surfaced in Living Memory, with a compact L1 summary injected into AI prompts and a full L2 markdown document the agent can pull on demand.

**Architecture:** The brief is a new `translationBrief` key on the existing `project_settings` JSON blob (same sync path as `livingMemoryEntries`/`systemPrompt`, maintainer-gated). Pure logic (schema, status, staleness, L2 assembly) lives in `src/lib/brief/`. LLM passes (L1 generation, doc extraction) mirror `rule-extractor.ts`. Consumption: the inline-completion path injects L1 via `buildPrompt`/`buildBatchPrompt`; the server-side agent injects L1 into its resident card and exposes L2 via a new `docs('brief')` cookbook. UI is a `BriefBuilder` dialog launched from a new section on the Living Memory page. Reference-only: the AI Instructions (`systemPrompt`) box is untouched.

**Tech Stack:** React + TypeScript (Vite), vitest (happy-dom), IndexedDB sync via `useProjectSettings`, Cloudflare Workers (auth-worker) for the agent, Postgres (`AQUILLA_PG`).

**Spec:** `docs/superpowers/specs/2026-06-17-translation-brief-design.md`

---

## Type & name contract (used across all tasks — keep identical)

```ts
// src/lib/brief/types.ts
export type BriefGroup = "purpose" | "standards"
export type BriefStatus = "none" | "draft" | "complete"

export interface BriefField {
  id: string
  label: string
  group: BriefGroup
  helperText: string
}

export interface TranslationBrief {
  version: number                      // bumped on each save
  updatedAt: string                    // ISO 8601 UTC (always …Z)
  updatedBy: string
  parameters: Record<string, string>   // keyed by BriefField.id; sparse (unanswered ids absent)
  freeformNotes: string
  l2Markdown: string                    // assembled full doc, editable
  l1Summary: string | null              // compact actionable summary
  l1GeneratedAt: string | null          // set === updatedAt on the save that generates L1
  l1ModelId: string | null
}
```

The 11 field ids (stable, never rename): `purpose`, `audience`, `useAndMedium`,
`motiveSponsor`, `sourceTexts`, `targetVariety`, `registerNaturalness`,
`literalness`, `keyTerms`, `constraints`, `qualityBar`.

`L1_MAX_CHARS = 1600` (~250 words; protects the per-call token budget).

---

## Phase 1 — Pure core (no network, no UI)

### Task 1: Brief types + field schema

**Files:**
- Create: `src/lib/brief/types.ts`
- Create: `src/lib/brief/schema.ts`
- Test: `src/lib/brief/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/brief/schema.test.ts
import { describe, it, expect } from "vitest"
import { BRIEF_FIELDS, L1_MAX_CHARS } from "./schema"

describe("BRIEF_FIELDS", () => {
  it("has the 11 spec fields with unique ids", () => {
    const ids = BRIEF_FIELDS.map((f) => f.id)
    expect(ids).toEqual([
      "purpose", "audience", "useAndMedium", "motiveSponsor",
      "sourceTexts", "targetVariety", "registerNaturalness", "literalness",
      "keyTerms", "constraints", "qualityBar",
    ])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("groups the first four under purpose, the rest under standards", () => {
    const byId = Object.fromEntries(BRIEF_FIELDS.map((f) => [f.id, f.group]))
    expect(byId.purpose).toBe("purpose")
    expect(byId.motiveSponsor).toBe("purpose")
    expect(byId.sourceTexts).toBe("standards")
    expect(byId.qualityBar).toBe("standards")
  })

  it("gives every field a non-empty label and helperText (the interview needs both)", () => {
    for (const f of BRIEF_FIELDS) {
      expect(f.label.trim().length).toBeGreaterThan(0)
      expect(f.helperText.trim().length).toBeGreaterThan(0)
    }
  })

  it("caps L1 length to protect the prompt token budget", () => {
    expect(L1_MAX_CHARS).toBe(1600)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/brief/schema.test.ts`
Expected: FAIL — cannot find module `./schema`.

- [ ] **Step 3: Write the types and schema**

```ts
// src/lib/brief/types.ts
export type BriefGroup = "purpose" | "standards"
export type BriefStatus = "none" | "draft" | "complete"

export interface BriefField {
  id: string
  label: string
  group: BriefGroup
  helperText: string
}

export interface TranslationBrief {
  version: number
  updatedAt: string
  updatedBy: string
  parameters: Record<string, string>
  freeformNotes: string
  l2Markdown: string
  l1Summary: string | null
  l1GeneratedAt: string | null
  l1ModelId: string | null
}
```

```ts
// src/lib/brief/schema.ts
import type { BriefField } from "./types"

/** Max L1 length in characters (~250 words). Enforced at generation so the
 *  always-injected summary cannot blow the per-completion token budget. */
export const L1_MAX_CHARS = 1600

/**
 * The code-owned interview schema. Order is the interview order. Field ids are
 * stable storage keys (never rename — they key TranslationBrief.parameters).
 * Group A = skopos/Nord purpose dimensions; Group B = Paratext project standards.
 */
export const BRIEF_FIELDS: BriefField[] = [
  {
    id: "purpose",
    label: "Purpose / skopos",
    group: "purpose",
    helperText:
      "Why this translation exists and its intended function(s): e.g. evangelistic, liturgical, study, devotional, first Scripture in this language, or a revision.",
  },
  {
    id: "audience",
    label: "Audience / addressees",
    group: "purpose",
    helperText:
      "Who will use it — age range, literacy level, churched vs. unchurched, and whether they are bilingual with a language of wider communication.",
  },
  {
    id: "useAndMedium",
    label: "Intended use & medium",
    group: "purpose",
    helperText:
      "How it will be encountered: read aloud, personal study, liturgy, audio/oral, print, or app. The medium shapes sentence length and naturalness.",
  },
  {
    id: "motiveSponsor",
    label: "Motive & sponsor",
    group: "purpose",
    helperText:
      "Who commissioned the work and the denominational or institutional context behind it. Records the brief's 'motive' in skopos terms.",
  },
  {
    id: "sourceTexts",
    label: "Source & base texts",
    group: "standards",
    helperText:
      "The original-language editions and any front/model translations the team works from.",
  },
  {
    id: "targetVariety",
    label: "Target language & variety",
    group: "standards",
    helperText:
      "The specific dialect/variety and any orthography decisions (spelling system, script, punctuation conventions).",
  },
  {
    id: "registerNaturalness",
    label: "Register & naturalness",
    group: "standards",
    helperText:
      "Formal vs. informal register, and how strongly the team prefers natural target-language phrasing over concordance with the source.",
  },
  {
    id: "literalness",
    label: "Level of literalness",
    group: "standards",
    helperText:
      "Where the translation sits on the formal ↔ functional equivalence spectrum, and when adaptation is acceptable.",
  },
  {
    id: "keyTerms",
    label: "Key terms & theological tradition",
    group: "standards",
    helperText:
      "Key-term strategy, denominational constraints, and whether to transliterate or use indigenous terms for difficult concepts.",
  },
  {
    id: "constraints",
    label: "Constraints & sensitivities",
    group: "standards",
    helperText:
      "Cultural, political, or religious taboos and any renderings that must be avoided.",
  },
  {
    id: "qualityBar",
    label: "Quality bar",
    group: "standards",
    helperText:
      "What 'good' and 'done' mean for this project — the standard a draft must meet before it is acceptable.",
  },
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/brief/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/brief/types.ts src/lib/brief/schema.ts src/lib/brief/schema.test.ts
git commit -m "feat(brief): brief types + skopos/Paratext interview schema"
```

---

### Task 2: Brief helpers — empty/status/staleness/L2 assembly

**Files:**
- Create: `src/lib/brief/brief.ts`
- Test: `src/lib/brief/brief.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/brief/brief.test.ts
import { describe, it, expect } from "vitest"
import { emptyBrief, isL1Stale, briefStatus, filledFieldCount, assembleL2Markdown } from "./brief"
import { BRIEF_FIELDS } from "./schema"
import type { TranslationBrief } from "./types"

function fullParams(): Record<string, string> {
  return Object.fromEntries(BRIEF_FIELDS.map((f) => [f.id, `value for ${f.id}`]))
}

describe("emptyBrief", () => {
  it("creates a blank, never-summarized brief attributed to the author", () => {
    const b = emptyBrief("alice")
    expect(b.version).toBe(0)
    expect(b.updatedBy).toBe("alice")
    expect(b.parameters).toEqual({})
    expect(b.l1Summary).toBeNull()
    expect(b.l1GeneratedAt).toBeNull()
    expect(b.updatedAt).toMatch(/Z$/) // ISO UTC
  })
})

describe("filledFieldCount", () => {
  it("counts only non-empty trimmed schema fields", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "x", audience: "   ", keyTerms: "y" } }
    expect(filledFieldCount(b)).toBe(2) // audience is whitespace-only
  })
})

describe("isL1Stale", () => {
  it("is stale when L1 was never generated", () => {
    expect(isL1Stale(emptyBrief("a"))).toBe(true)
  })
  it("is stale when content changed after L1 generation", () => {
    const b: TranslationBrief = { ...emptyBrief("a"), l1Summary: "s", l1GeneratedAt: "2026-06-17T10:00:00.000Z", updatedAt: "2026-06-17T11:00:00.000Z" }
    expect(isL1Stale(b)).toBe(true)
  })
  it("is fresh when L1 was generated on the latest save", () => {
    const b: TranslationBrief = { ...emptyBrief("a"), l1Summary: "s", l1GeneratedAt: "2026-06-17T11:00:00.000Z", updatedAt: "2026-06-17T11:00:00.000Z" }
    expect(isL1Stale(b)).toBe(false)
  })
})

describe("briefStatus", () => {
  it("none when absent", () => {
    expect(briefStatus(null)).toBe("none")
    expect(briefStatus(undefined)).toBe("none")
  })
  it("draft when partially filled", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "x" } }
    expect(briefStatus(b)).toBe("draft")
  })
  it("draft when all fields filled but L1 missing/stale", () => {
    const b = { ...emptyBrief("a"), parameters: fullParams() }
    expect(briefStatus(b)).toBe("draft")
  })
  it("complete only when every field filled and a current L1 exists", () => {
    const b: TranslationBrief = { ...emptyBrief("a"), parameters: fullParams(), l1Summary: "s", l1GeneratedAt: "2026-06-17T11:00:00.000Z", updatedAt: "2026-06-17T11:00:00.000Z" }
    expect(briefStatus(b)).toBe("complete")
  })
})

describe("assembleL2Markdown", () => {
  it("renders filled fields under group headings and omits empty ones", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "Evangelistic", literalness: "Functional" }, freeformNotes: "Avoid archaic words." }
    const md = assembleL2Markdown(b)
    expect(md).toContain("# Translation Brief")
    expect(md).toContain("## Purpose & audience")
    expect(md).toContain("### Purpose / skopos")
    expect(md).toContain("Evangelistic")
    expect(md).not.toContain("### Audience / addressees") // empty → omitted
    expect(md).toContain("## Additional notes")
    expect(md).toContain("Avoid archaic words.")
  })
  it("omits the notes section when there are no notes", () => {
    const b = { ...emptyBrief("a"), parameters: { purpose: "x" } }
    expect(assembleL2Markdown(b)).not.toContain("## Additional notes")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/brief/brief.test.ts`
Expected: FAIL — cannot find module `./brief`.

- [ ] **Step 3: Write the helpers**

```ts
// src/lib/brief/brief.ts
import { BRIEF_FIELDS } from "./schema"
import type { BriefGroup, BriefStatus, TranslationBrief } from "./types"

/** A blank brief. version 0 mirrors the project_settings "no server row" floor. */
export function emptyBrief(author: string): TranslationBrief {
  return {
    version: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: author,
    parameters: {},
    freeformNotes: "",
    l2Markdown: "",
    l1Summary: null,
    l1GeneratedAt: null,
    l1ModelId: null,
  }
}

/** Count schema fields with non-empty (trimmed) answers. */
export function filledFieldCount(brief: TranslationBrief): number {
  return BRIEF_FIELDS.reduce(
    (n, f) => n + ((brief.parameters[f.id] ?? "").trim() ? 1 : 0),
    0,
  )
}

/**
 * L1 is stale when it was never generated, or when the brief was edited after
 * the last generation. The generation flow sets l1GeneratedAt === updatedAt of
 * that same save, so a freshly generated L1 is not stale; a later content edit
 * advances updatedAt past it. ISO-8601 UTC strings compare chronologically.
 */
export function isL1Stale(brief: TranslationBrief): boolean {
  if (!brief.l1Summary || !brief.l1GeneratedAt) return true
  return brief.updatedAt > brief.l1GeneratedAt
}

/** Derived status — never stored. */
export function briefStatus(brief: TranslationBrief | null | undefined): BriefStatus {
  if (!brief) return "none"
  const allFilled = filledFieldCount(brief) === BRIEF_FIELDS.length
  if (allFilled && !isL1Stale(brief)) return "complete"
  return "draft"
}

const GROUP_HEADINGS: Record<BriefGroup, string> = {
  purpose: "Purpose & audience",
  standards: "Standards",
}

/**
 * Render the brief as a clean markdown document from the filled parameters and
 * freeform notes. Empty fields are omitted (not stubbed) so a partial brief
 * still reads cleanly. This is the canonical L2 the agent can pull on demand.
 */
export function assembleL2Markdown(brief: TranslationBrief): string {
  const parts: string[] = ["# Translation Brief"]
  for (const group of ["purpose", "standards"] as BriefGroup[]) {
    const fields = BRIEF_FIELDS.filter(
      (f) => f.group === group && (brief.parameters[f.id] ?? "").trim(),
    )
    if (!fields.length) continue
    parts.push(`## ${GROUP_HEADINGS[group]}`)
    for (const f of fields) {
      parts.push(`### ${f.label}\n${brief.parameters[f.id].trim()}`)
    }
  }
  if (brief.freeformNotes.trim()) {
    parts.push(`## Additional notes\n${brief.freeformNotes.trim()}`)
  }
  return parts.join("\n\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/brief/brief.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/brief/brief.ts src/lib/brief/brief.test.ts
git commit -m "feat(brief): empty/status/staleness/L2-assembly helpers"
```

---

## Phase 2 — Data model wiring (sync round-trip)

### Task 3: Add `translationBrief` to ProjectWideSettings + IDB mirror

**Files:**
- Modify: `src/lib/sync/project-settings.ts:22-66` (add the key) and import
- Modify: `src/hooks/useProjectSettings.ts:75-101` (`localSettingsFrom`) and `:179-217` (refresh→IDB mirror)
- Modify: `src/hooks/useProject.ts:35` (overlay) — see Step 3
- Test: `src/lib/sync/project-settings.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/sync/project-settings.test.ts`:

```ts
import type { TranslationBrief } from "@/lib/brief/types"

describe("ProjectWideSettings.translationBrief", () => {
  it("serializes a brief in the settings payload round-trip", () => {
    const brief: TranslationBrief = {
      version: 1, updatedAt: "2026-06-17T11:00:00.000Z", updatedBy: "alice",
      parameters: { purpose: "Evangelistic" }, freeformNotes: "",
      l2Markdown: "# Translation Brief", l1Summary: "Be evangelistic.",
      l1GeneratedAt: "2026-06-17T11:00:00.000Z", l1ModelId: "claude",
    }
    const settings: import("./project-settings").ProjectWideSettings = { translationBrief: brief }
    const json = JSON.parse(JSON.stringify(settings))
    expect(json.translationBrief.parameters.purpose).toBe("Evangelistic")
    expect(json.translationBrief.l1Summary).toBe("Be evangelistic.")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/sync/project-settings.test.ts`
Expected: FAIL — `translationBrief` not assignable to `ProjectWideSettings` (TS error).

- [ ] **Step 3: Add the key and mirror it through the cache paths**

In `src/lib/sync/project-settings.ts`, add the import near line 10 and the key inside `ProjectWideSettings` (after `livingMemoryEntries?` at line 51):

```ts
import type { TranslationBrief } from "@/lib/brief/types"
```
```ts
  /** The project's skopos/Paratext translation brief. Synced like
   *  `livingMemoryEntries` — replacing this key replaces the whole object.
   *  Absent → no brief authored yet. See
   *  docs/superpowers/specs/2026-06-17-translation-brief-design.md. */
  translationBrief?: TranslationBrief
```

In `src/hooks/useProjectSettings.ts` `localSettingsFrom` (after the `livingMemoryEntries` line ~99):

```ts
  if (record.translationBrief != null) out.translationBrief = record.translationBrief
```

In the same file, inside `refresh`'s IDB mirror `patchProject` updater (after the `livingMemoryEntries` spread ~214-216):

```ts
          ...(got.settings.translationBrief != null
            ? { translationBrief: got.settings.translationBrief }
            : {}),
```

In `src/hooks/useProject.ts`, the overlay at line ~35 currently lifts `systemPrompt`. Add `translationBrief` so a project record exposes it (match the existing object-spread style at that call — include `translationBrief: settings.translationBrief` in the overlaid settings object).

> NOTE: `record.translationBrief` requires the project IDB record type to allow the field. If `getProject`'s record type is a structural `ProjectRecord`, add `translationBrief?: TranslationBrief` to it (search: `interface ProjectRecord` under `src/lib/store/project-index.ts`) and import the type there. If the record type is already `Partial<ProjectWideSettings> & {...}`, no change is needed.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run src/lib/sync/project-settings.test.ts`
Expected: PASS.
Run: `pnpm tsc -p tsconfig.json --noEmit` (or the repo's typecheck script)
Expected: no new errors in the touched files.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/project-settings.ts src/hooks/useProjectSettings.ts src/hooks/useProject.ts src/lib/sync/project-settings.test.ts src/lib/store/project-index.ts
git commit -m "feat(brief): sync translationBrief through project settings + IDB mirror"
```

---

## Phase 3 — LLM generation (mirror rule-extractor)

### Task 4: L1 summary generation

**Files:**
- Create: `src/lib/brief/brief-generator.ts`
- Test: `src/lib/brief/brief-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/brief/brief-generator.test.ts
import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/completion/completion-service", () => ({
  complete: vi.fn(),
}))
import { complete } from "@/lib/completion/completion-service"
import { generateL1Summary } from "./brief-generator"
import { emptyBrief } from "./brief"
import { L1_MAX_CHARS } from "./schema"
import type { CompletionSettings } from "@/lib/parsers/types"

const settings = { model: "m", provider: "frontier", maxTokens: 4096, temperature: 0.2 } as unknown as CompletionSettings

describe("generateL1Summary", () => {
  it("sends the assembled L2 to the model and returns its summary", async () => {
    vi.mocked(complete).mockResolvedValue("Translate evangelistically for young readers.")
    const brief = { ...emptyBrief("a"), parameters: { purpose: "Evangelistic", audience: "Youth" } }
    const out = await generateL1Summary(brief, settings, null)
    expect(out).toBe("Translate evangelistically for young readers.")
    const userMsg = vi.mocked(complete).mock.calls[0][0].messages.at(-1)!.content
    expect(userMsg).toContain("Evangelistic") // L2 content fed to the model
  })

  it("truncates an over-long summary to the L1 cap", async () => {
    vi.mocked(complete).mockResolvedValue("x".repeat(L1_MAX_CHARS + 500))
    const out = await generateL1Summary({ ...emptyBrief("a"), parameters: { purpose: "p" } }, settings, null)
    expect(out.length).toBeLessThanOrEqual(L1_MAX_CHARS)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/brief/brief-generator.test.ts`
Expected: FAIL — cannot find `generateL1Summary`.

- [ ] **Step 3: Implement generation**

```ts
// src/lib/brief/brief-generator.ts
import { complete } from "@/lib/completion/completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { UsageCallback } from "@/lib/rules/rule-suggester"
import { assembleL2Markdown } from "./brief"
import { L1_MAX_CHARS } from "./schema"
import type { TranslationBrief } from "./types"

const L1_SYSTEM_PROMPT = `You are condensing a Bible/translation project's full translation brief into a SHORT, practical, actionable summary for an AI translation assistant.

Write direct instructions the assistant can apply on every draft: who the audience is, the purpose, the register and level of literalness, key-term and naturalness preferences, and anything it must avoid. Be concrete and imperative ("Translate for…", "Prefer…", "Avoid…").

Rules:
- Under ${L1_MAX_CHARS} characters. Tighter is better.
- No preamble, no headings, no markdown — just the guidance prose.
- Only include what the brief states; do not invent constraints.`

/** Generate the compact, always-injected L1 summary from the brief's content. */
export async function generateL1Summary(
  brief: TranslationBrief,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<string> {
  const l2 = brief.l2Markdown.trim() || assembleL2Markdown(brief)
  const response = await complete({
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 1024), temperature: 0.2 },
    session,
    messages: [
      { role: "system", content: L1_SYSTEM_PROMPT },
      { role: "user", content: `Summarize this translation brief:\n\n${l2}` },
    ],
  })
  onLlmCall?.({
    kind: "brief-generate-l1",
    model: settings.model,
    provider: settings.provider || "frontier",
  })
  const text = response.trim()
  return text.length > L1_MAX_CHARS ? text.slice(0, L1_MAX_CHARS).trimEnd() : text
}
```

> NOTE: the `UsageCallback` `kind` is a free-form string in `rule-suggester.ts`
> (`rule-extract-pass1` etc.), so `"brief-generate-l1"` needs no type change.
> If `kind` is a union, add `"brief-generate-l1"` and `"brief-extract"` to it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/brief/brief-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/brief/brief-generator.ts src/lib/brief/brief-generator.test.ts
git commit -m "feat(brief): LLM L1 summary generation with length cap"
```

---

### Task 5: Document → parameters extraction (optional pre-fill)

**Files:**
- Modify: `src/lib/brief/brief-generator.ts` (add `extractBriefFromDocument`)
- Test: `src/lib/brief/brief-generator.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/brief/brief-generator.test.ts`:

```ts
import { extractBriefFromDocument, parseExtractedParameters } from "./brief-generator"

describe("parseExtractedParameters", () => {
  it("keeps only known field ids and string values", () => {
    const raw = JSON.stringify({ purpose: "Evangelistic", bogus: "x", audience: 5, keyTerms: "Use 'God'" })
    expect(parseExtractedParameters(raw)).toEqual({ purpose: "Evangelistic", keyTerms: "Use 'God'" })
  })
  it("tolerates code fences and surrounding prose", () => {
    const raw = "Here you go:\n```json\n{\"purpose\":\"P\"}\n```"
    expect(parseExtractedParameters(raw)).toEqual({ purpose: "P" })
  })
  it("returns {} on garbage", () => {
    expect(parseExtractedParameters("not json")).toEqual({})
  })
})

describe("extractBriefFromDocument", () => {
  it("maps a document into the known parameter ids", async () => {
    vi.mocked(complete).mockResolvedValue(JSON.stringify({ purpose: "Study Bible", literalness: "Formal" }))
    const out = await extractBriefFromDocument("Our project is a formal study Bible…", settings, null)
    expect(out).toEqual({ purpose: "Study Bible", literalness: "Formal" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/brief/brief-generator.test.ts`
Expected: FAIL — `extractBriefFromDocument`/`parseExtractedParameters` not exported.

- [ ] **Step 3: Implement extraction**

Add to `src/lib/brief/brief-generator.ts`:

```ts
import { BRIEF_FIELDS } from "./schema"

const EXTRACT_SYSTEM_PROMPT = `You read an existing translation brief or project-guidelines document and map its content onto a fixed set of fields.

Output a single JSON object whose keys are ONLY from this list (omit any field the document does not address):
${BRIEF_FIELDS.map((f) => `- "${f.id}": ${f.label} — ${f.helperText}`).join("\n")}

Each value is a concise plain-text answer drawn from the document.
Output ONLY valid JSON — no markdown, no code fences, no commentary.`

const FIELD_IDS = new Set(BRIEF_FIELDS.map((f) => f.id))

/** Parse the extractor response into a sparse, validated parameters map. */
export function parseExtractedParameters(raw: string): Record<string, string> {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return {}
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (FIELD_IDS.has(k) && typeof v === "string" && v.trim()) out[k] = v.trim()
    }
    return out
  } catch {
    return {}
  }
}

/** Single LLM pass: document text → sparse parameters map (known ids only). */
export async function extractBriefFromDocument(
  docText: string,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<Record<string, string>> {
  const response = await complete({
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 2048), temperature: 0.1 },
    session,
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: `Extract brief fields from this document:\n\n${docText}` },
    ],
  })
  onLlmCall?.({ kind: "brief-extract", model: settings.model, provider: settings.provider || "frontier" })
  return parseExtractedParameters(response)
}
```

Reuse `checkInputSize` from `rule-extractor.ts` at the call site (Task 8) for the 200 KB guard — do not duplicate it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/brief/brief-generator.test.ts`
Expected: PASS (all generator tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/brief/brief-generator.ts src/lib/brief/brief-generator.test.ts
git commit -m "feat(brief): LLM document→parameters extraction for pre-fill"
```

---

## Phase 4 — AI consumption (inline completion path)

### Task 6: `buildBriefBlock` + inject L1 into prompts

**Files:**
- Modify: `src/lib/completion/completion-service.ts` (add helper + thread `briefSummary` into `buildPrompt` ~134 and `buildBatchPrompt` ~200)
- Test: `src/lib/completion/completion-service.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/completion/completion-service.test.ts`:

```ts
import { buildBriefBlock } from "./completion-service"

describe("buildBriefBlock", () => {
  it("wraps a non-empty summary in a labeled block", () => {
    expect(buildBriefBlock("Translate for youth.")).toContain("Translation brief")
    expect(buildBriefBlock("Translate for youth.")).toContain("Translate for youth.")
  })
  it("returns empty string for blank input", () => {
    expect(buildBriefBlock("")).toBe("")
    expect(buildBriefBlock("   ")).toBe("")
  })
})

describe("buildPrompt with brief summary", () => {
  it("injects the brief block into the system message when present", () => {
    const [sys] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "X", systemPrompt: "Base.",
      sourceText: "logos", examples: [], briefSummary: "Prefer natural phrasing.",
    })
    expect(sys.content).toContain("Prefer natural phrasing.")
  })
  it("omits the brief block when absent", () => {
    const [sys] = buildPrompt({
      sourceLanguage: "Greek", targetLanguage: "X", systemPrompt: "Base.",
      sourceText: "logos", examples: [],
    })
    expect(sys.content).not.toContain("Translation brief")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/completion/completion-service.test.ts`
Expected: FAIL — `buildBriefBlock` not exported / `briefSummary` not a valid option.

- [ ] **Step 3: Implement**

In `src/lib/completion/completion-service.ts`, add after `buildRulesBlock` (~line 87):

```ts
/**
 * Render the brief's L1 summary as a labeled block for the system prompt.
 * Empty/blank input → "" (caller skips injection). The brief states the
 * project's purpose, audience, register, and constraints; it sits ABOVE the
 * mechanical rules block so the model reads intent before specifics.
 */
export function buildBriefBlock(summary: string | undefined | null): string {
  const s = (summary ?? "").trim()
  if (!s) return ""
  return "Translation brief (the project's purpose and standards — follow it):\n" + s
}
```

In `buildPrompt`'s options type (~134-143) add:
```ts
  /** The project brief's L1 summary — injected before the rules block. */
  briefSummary?: string
```
and inject it in `buildPrompt`, immediately after the placeholder interpolation (after line 146, BEFORE the rules block at 148-152):
```ts
  const briefBlock = buildBriefBlock(options.briefSummary)
  if (briefBlock) sys = sys + "\n\n" + briefBlock
```

In `buildBatchPrompt`'s options type (~200-214) add the same `briefSummary?: string` field, and inject after `baseSys` is first assigned (after line 217, before the rules block at 219-222):
```ts
  const batchBriefBlock = buildBriefBlock(options.briefSummary)
  if (batchBriefBlock) baseSys = baseSys + "\n\n" + batchBriefBlock
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/completion/completion-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/completion/completion-service.ts src/lib/completion/completion-service.test.ts
git commit -m "feat(brief): inject brief L1 summary into completion prompts"
```

---

### Task 7: Thread `briefSummary` through `useCompletion` → call site

**Files:**
- Modify: `src/hooks/useCompletion.ts:82-96` (add param), `:157-165` (single), `:303-311` (batch), and both `useCallback` dep arrays (`:202`, `:442`)
- Modify: `src/components/ProjectWorkspace.tsx:1311` (pass the brief L1 at the call site)

- [ ] **Step 1: Add the param to `useCompletion`**

After the `allCells?: CellData[],` parameter (line 96) add:
```ts
  /** The project brief's L1 summary — injected into every prompt (Task 6). */
  briefSummary?: string,
```

In the single-cell `buildPrompt({...})` call (~157-165) add `briefSummary,` next to `rules,`. In the batch `buildBatchPrompt({...})` call (~305-311) add `briefSummary,` next to `rules,`. Add `briefSummary` to both `useCallback` dependency arrays (lines 202 and 442).

- [ ] **Step 2: Source the brief L1 at the call site**

In `src/components/ProjectWorkspace.tsx`, the component already reads project settings (it patches `systemPrompt` at line 2219). Locate the `useProjectSettings(...)` / settings object in scope there and pass its brief L1 into the `useCompletion(...)` call at line 1311 as the new trailing argument:
```ts
  // …existing trailing args…, rules, fileCells, settings.translationBrief?.l1Summary)
```
If the settings object in that scope is named differently (e.g. `projectSettings`), use that name. The value is `<settingsObj>.translationBrief?.l1Summary` (a `string | undefined`).

- [ ] **Step 3: Typecheck + run the completion suite**

Run: `pnpm tsc -p tsconfig.json --noEmit`
Expected: no new errors.
Run: `pnpm vitest run src/lib/completion src/hooks`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useCompletion.ts src/components/ProjectWorkspace.tsx
git commit -m "feat(brief): wire brief L1 into useCompletion at the workspace call site"
```

---

## Phase 5 — Agent integration (auth-worker)

### Task 8: `docs('brief')` cookbook (L2 on demand)

**Files:**
- Modify: `auth-worker/src/lib/agent/docs.ts` (add `BRIEF` cookbook + register it)
- Test: `auth-worker/src/__tests__/agent-docs-brief.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// auth-worker/src/__tests__/agent-docs-brief.test.ts
import { describe, it, expect } from "vitest"
import { getCookbook, COOKBOOK_TOPICS } from "../lib/agent/docs"

describe("brief cookbook", () => {
  it("is a registered topic", () => {
    expect(COOKBOOK_TOPICS).toContain("brief")
  })
  it("returns a recipe that reads translationBrief from project_settings", () => {
    const { ok, text } = getCookbook("brief")
    expect(ok).toBe(true)
    expect(text).toContain("translationBrief")
    expect(text).toContain("project_settings")
    expect(text).toContain("l2Markdown")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root): `pnpm --dir auth-worker vitest run src/__tests__/agent-docs-brief.test.ts`
(If the repo uses a different invocation, `cd auth-worker && pnpm vitest run src/__tests__/agent-docs-brief.test.ts`.)
Expected: FAIL — "brief" not in COOKBOOK_TOPICS.

- [ ] **Step 3: Add the cookbook**

In `auth-worker/src/lib/agent/docs.ts`, add a constant before `COOKBOOKS` (~line 278):

```ts
const BRIEF = `# Translation brief cookbook — the project's purpose & standards

The brief encodes WHY this translation exists and the standards it must meet
(skopos: audience, purpose, medium, register, literalness, key terms,
constraints). A short summary is already in your system card; fetch the FULL
brief only when a judgment call needs the detail behind the summary.

The brief lives in project_settings as JSON (key 'translationBrief'):
SELECT settings::jsonb -> 'translationBrief' ->> 'l1Summary'  AS summary,
       settings::jsonb -> 'translationBrief' ->> 'l2Markdown' AS full_brief,
       settings::jsonb -> 'translationBrief' -> 'parameters'  AS parameters
FROM project_settings WHERE project_id = :project

When drafting or checking, honour the brief: match the stated register and level
of literalness, apply the key-term strategy, and avoid anything the constraints
forbid. If the brief and a validated pair conflict, prefer the validated pair
(it is observed project practice) but flag the tension to the user.
If 'translationBrief' is null, the project has not authored a brief yet — say so
rather than inventing standards.`
```

Register it in the `COOKBOOKS` record:
```ts
  brief: BRIEF,
```

Add `brief` to the topic listing string in `auth-worker/src/routes/agent.ts:104`:
```ts
            "Fetch a cookbook: drafting | checking | terminology | validation | history | assignments | files-and-refs | brief",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir auth-worker vitest run src/__tests__/agent-docs-brief.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add auth-worker/src/lib/agent/docs.ts auth-worker/src/routes/agent.ts auth-worker/src/__tests__/agent-docs-brief.test.ts
git commit -m "feat(brief): agent docs('brief') cookbook for L2 on demand"
```

---

### Task 9: Inject brief L1 into the agent's resident card

**Files:**
- Modify: `auth-worker/src/lib/agent/schema-card.ts` (`AgentPromptContext` ~167-201, `buildSystemPrompt` ~251-285, new `briefBlock` helper)
- Modify: `auth-worker/src/routes/agent.ts:329-341` (extend the settings SELECT) and `:353-370` (pass `briefSummary`)
- Test: `auth-worker/src/__tests__/agent-schema-card.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `auth-worker/src/__tests__/agent-schema-card.test.ts` (match its existing import of `buildSystemPrompt`):

```ts
describe("buildSystemPrompt brief block", () => {
  const base = { projectId: "p", username: "u", roleLevel: 600 }
  it("includes the brief summary when provided", () => {
    const out = buildSystemPrompt({ ...base, briefSummary: "Translate for unchurched youth." })
    expect(out).toContain("Translate for unchurched youth.")
    expect(out).toContain("docs('brief')") // points the agent at the full L2
  })
  it("omits the brief section when no summary is set", () => {
    const out = buildSystemPrompt(base)
    expect(out).not.toContain("Project translation brief")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir auth-worker vitest run src/__tests__/agent-schema-card.test.ts`
Expected: FAIL — `briefSummary` not on `AgentPromptContext`.

- [ ] **Step 3: Implement**

In `auth-worker/src/lib/agent/schema-card.ts`, add to `AgentPromptContext` (near `targetLanguage?` ~182):
```ts
  /** project_settings.translationBrief.l1Summary — the brief's resident summary. */
  briefSummary?: string
```

Add a helper near `translatorProfileBlock` (~218):
```ts
function briefBlock(ctx: AgentPromptContext): string {
  const s = (ctx.briefSummary ?? "").trim()
  if (!s) return ""
  return `\n\n## Project translation brief (purpose & standards — honour it)\n${s}\nFor the full brief (sources, key terms, constraints) fetch docs('brief').`
}
```

In `buildSystemPrompt`'s returned template (~282-285), append `${briefBlock(ctx)}` after `${translatorProfileBlock(ctx)}` (or alongside the aquifer block — anywhere in the resident card is fine; keep it before the schema card so intent reads first).

In `auth-worker/src/routes/agent.ts`, extend the settings SELECT (~329-335) to also read the summary:
```ts
    const settings = await env.AQUILLA_PG.prepare(
      `SELECT settings::jsonb ->> 'sourceLanguage' AS source_language,
              settings::jsonb ->> 'targetLanguage' AS target_language,
              settings::jsonb -> 'translationBrief' ->> 'l1Summary' AS brief_summary
       FROM project_settings WHERE project_id = ?`,
    )
      .bind(body.projectId)
      .first<{ source_language: string | null; target_language: string | null; brief_summary: string | null }>()
```
Capture it into a run-scoped variable next to `languages` (declare `let briefSummary: string | undefined` near the top of the try block, then `if (settings) briefSummary = settings.brief_summary ?? undefined`). Pass it into `buildSystemPrompt({...})` (~353):
```ts
        briefSummary,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir auth-worker vitest run src/__tests__/agent-schema-card.test.ts`
Expected: PASS.
Run: `pnpm --dir auth-worker vitest run src/__tests__/agent-route.test.ts`
Expected: PASS (no regression in run assembly).

- [ ] **Step 5: Commit**

```bash
git add auth-worker/src/lib/agent/schema-card.ts auth-worker/src/routes/agent.ts auth-worker/src/__tests__/agent-schema-card.test.ts
git commit -m "feat(brief): inject brief L1 into the agent resident card"
```

---

## Phase 6 — UI

### Task 10: Brief authoring controller hook

A small hook centralizes brief draft state + save + L1 generation so the UI
component stays thin and the logic is unit-testable.

**Files:**
- Create: `src/hooks/useTranslationBrief.ts`
- Test: `src/hooks/useTranslationBrief.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/useTranslationBrief.test.ts
import { describe, it, expect, vi } from "vitest"
import { buildSavePayload, withGeneratedL1 } from "./useTranslationBrief"
import { emptyBrief } from "@/lib/brief/brief"

describe("buildSavePayload", () => {
  it("bumps version, refreshes updatedAt/updatedBy, reassembles L2", () => {
    const prev = emptyBrief("alice")
    const next = buildSavePayload(prev, { parameters: { purpose: "Evangelistic" }, freeformNotes: "" }, "bob")
    expect(next.version).toBe(prev.version + 1)
    expect(next.updatedBy).toBe("bob")
    expect(next.updatedAt >= prev.updatedAt).toBe(true)
    expect(next.l2Markdown).toContain("Evangelistic")
    expect(next.parameters.purpose).toBe("Evangelistic")
  })
})

describe("withGeneratedL1", () => {
  it("stamps l1GeneratedAt === updatedAt so the result is not stale", () => {
    const saved = buildSavePayload(emptyBrief("a"), { parameters: { purpose: "p" }, freeformNotes: "" }, "a")
    const out = withGeneratedL1(saved, "Be evangelistic.", "claude")
    expect(out.l1Summary).toBe("Be evangelistic.")
    expect(out.l1ModelId).toBe("claude")
    expect(out.l1GeneratedAt).toBe(out.updatedAt)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/hooks/useTranslationBrief.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook + pure helpers**

```ts
// src/hooks/useTranslationBrief.ts
import { useCallback } from "react"
import { assembleL2Markdown } from "@/lib/brief/brief"
import type { TranslationBrief } from "@/lib/brief/types"

export interface BriefDraft {
  parameters: Record<string, string>
  freeformNotes: string
}

/** Pure: produce the next persisted brief from a draft (bump version, restamp,
 *  reassemble L2). Does NOT touch L1 — generation is a separate explicit step. */
export function buildSavePayload(
  prev: TranslationBrief,
  draft: BriefDraft,
  author: string,
): TranslationBrief {
  const next: TranslationBrief = {
    ...prev,
    version: prev.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: author,
    parameters: { ...draft.parameters },
    freeformNotes: draft.freeformNotes,
    l2Markdown: "",
  }
  next.l2Markdown = assembleL2Markdown(next)
  return next
}

/** Pure: attach a freshly generated L1, stamping l1GeneratedAt === updatedAt so
 *  isL1Stale() reports fresh until the next content edit. */
export function withGeneratedL1(
  brief: TranslationBrief,
  l1Summary: string,
  modelId: string,
): TranslationBrief {
  return { ...brief, l1Summary, l1ModelId: modelId, l1GeneratedAt: brief.updatedAt }
}

/** Thin controller: returns save/generate callbacks bound to the project's
 *  settings patch fn. `patch` is `useProjectSettings(...).patch`. */
export function useTranslationBrief(opts: {
  brief: TranslationBrief | undefined
  author: string
  patch: (partial: { translationBrief: TranslationBrief }) => Promise<unknown>
}) {
  const { brief, author, patch } = opts

  const save = useCallback(
    async (prev: TranslationBrief, draft: BriefDraft) => {
      const next = buildSavePayload(prev, draft, author)
      await patch({ translationBrief: next })
      return next
    },
    [author, patch],
  )

  const attachL1 = useCallback(
    async (saved: TranslationBrief, l1Summary: string, modelId: string) => {
      const next = withGeneratedL1(saved, l1Summary, modelId)
      await patch({ translationBrief: next })
      return next
    },
    [patch],
  )

  return { brief, save, attachL1 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/hooks/useTranslationBrief.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTranslationBrief.ts src/hooks/useTranslationBrief.test.ts
git commit -m "feat(brief): brief authoring controller hook + save/L1 helpers"
```

---

### Task 11: `BriefBuilder` dialog (interview + doc upload + generate)

**Files:**
- Create: `src/components/brief/BriefBuilder.tsx`
- Test: `src/components/brief/BriefBuilder.test.tsx`

This is the largest UI unit. It is a controlled dialog stepping through
`BRIEF_FIELDS`, exit-able at any step (Save draft), with an optional first
"upload/paste a document" step that pre-fills via `extractBriefFromDocument`, a
per-field "Help me write this" button (calls `complete` for a draft), a final
free-form notes step, and a "Generate summary" action.

- [ ] **Step 1: Write the failing test (logic-focused, happy-dom)**

```tsx
// src/components/brief/BriefBuilder.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { BriefBuilder } from "./BriefBuilder"
import { emptyBrief } from "@/lib/brief/brief"

function noopAsync() { return Promise.resolve(undefined) }

describe("BriefBuilder", () => {
  it("renders the first interview field and saves a draft with entered text", async () => {
    const onSave = vi.fn().mockResolvedValue(emptyBrief("a"))
    render(
      <BriefBuilder
        open
        brief={emptyBrief("a")}
        canEdit
        onSaveDraft={onSave}
        onGenerateL1={noopAsync}
        onClose={() => {}}
      />,
    )
    // First field label from the schema is "Purpose / skopos"
    expect(screen.getByText(/Purpose \/ skopos/i)).toBeTruthy()
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "Evangelistic for youth" } })
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0]
    expect(draft.parameters.purpose).toBe("Evangelistic for youth")
  })

  it("disables editing affordances when canEdit is false", () => {
    render(
      <BriefBuilder open brief={emptyBrief("a")} canEdit={false}
        onSaveDraft={noopAsync} onGenerateL1={noopAsync} onClose={() => {}} />,
    )
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/brief/BriefBuilder.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/components/brief/BriefBuilder.tsx`. Use the repo's existing UI primitives (match imports used in `RuleImportDialog.tsx` / `LivingMemoryPage.tsx`: `Dialog`, `Button`, `Textarea`, `Badge`). The component owns local `draft` state seeded from `brief`, an integer `stepIndex` over `BRIEF_FIELDS.length + 1` (last step = freeform notes), and renders:

```tsx
import { useState } from "react"
import { BRIEF_FIELDS } from "@/lib/brief/schema"
import type { TranslationBrief } from "@/lib/brief/types"
import type { BriefDraft } from "@/hooks/useTranslationBrief"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export interface BriefBuilderProps {
  open: boolean
  brief: TranslationBrief
  canEdit: boolean
  onSaveDraft: (draft: BriefDraft) => Promise<TranslationBrief | undefined>
  onGenerateL1: (draft: BriefDraft) => Promise<void>
  onClose: () => void
  /** Optional: per-field LLM draft helper. Absent → "Help me write this" hidden. */
  onHelpDraft?: (fieldId: string, draft: BriefDraft) => Promise<string>
  /** Optional: document pre-fill. Absent → upload step hidden. */
  onExtractDocument?: (text: string) => Promise<Record<string, string>>
}

export function BriefBuilder(props: BriefBuilderProps) {
  const { open, brief, canEdit, onSaveDraft, onGenerateL1, onClose, onHelpDraft, onExtractDocument } = props
  const [params, setParams] = useState<Record<string, string>>({ ...brief.parameters })
  const [notes, setNotes] = useState(brief.freeformNotes)
  // Resume at the first unanswered field (or 0). +1 slot is the notes step.
  const firstUnanswered = BRIEF_FIELDS.findIndex((f) => !(brief.parameters[f.id] ?? "").trim())
  const [step, setStep] = useState(firstUnanswered === -1 ? BRIEF_FIELDS.length : firstUnanswered)
  const [busy, setBusy] = useState(false)

  const draft: BriefDraft = { parameters: params, freeformNotes: notes }
  const isNotesStep = step >= BRIEF_FIELDS.length
  const field = isNotesStep ? null : BRIEF_FIELDS[step]

  function setField(id: string, value: string) {
    setParams((p) => ({ ...p, [id]: value }))
  }

  async function saveDraft() {
    setBusy(true)
    try { await onSaveDraft(draft) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Translation brief</DialogTitle>
        </DialogHeader>

        {onExtractDocument && step === 0 && (
          <DocumentPrefill
            disabled={!canEdit || busy}
            onExtract={async (text) => {
              setBusy(true)
              try {
                const extracted = await onExtractDocument(text)
                setParams((p) => ({ ...extracted, ...p })) // keep any manual edits
              } finally { setBusy(false) }
            }}
          />
        )}

        {field ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">{field.label}</div>
            <p className="text-xs text-muted-foreground">{field.helperText}</p>
            <Textarea
              value={params[field.id] ?? ""}
              readOnly={!canEdit}
              rows={5}
              onChange={(e) => setField(field.id, e.target.value)}
            />
            {canEdit && onHelpDraft && (
              <Button variant="ghost" size="sm" disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try { setField(field.id, await onHelpDraft(field.id, draft)) }
                  finally { setBusy(false) }
                }}>
                Help me write this
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium">Anything else the AI should know?</div>
            <Textarea value={notes} readOnly={!canEdit} rows={5}
              onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!canEdit || busy} onClick={saveDraft}>
              Save draft
            </Button>
            {isNotesStep ? (
              <Button disabled={!canEdit || busy}
                onClick={async () => { setBusy(true); try { await onSaveDraft(draft); await onGenerateL1(draft) } finally { setBusy(false) } }}>
                Save & generate summary
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => setStep((s) => s + 1)}>Next</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DocumentPrefill(props: { disabled: boolean; onExtract: (text: string) => Promise<void> }) {
  const [text, setText] = useState("")
  return (
    <div className="space-y-2 rounded-lg border border-border/50 p-3">
      <div className="text-xs font-medium">Optional: paste an existing brief to pre-fill</div>
      <Textarea value={text} rows={3} disabled={props.disabled}
        placeholder="Paste notes or an existing brief…" onChange={(e) => setText(e.target.value)} />
      <Button size="sm" variant="secondary" disabled={props.disabled || !text.trim()}
        onClick={() => props.onExtract(text)}>
        Pre-fill from text
      </Button>
    </div>
  )
}
```

> If `@/components/ui/textarea` or `dialog` paths differ, match the exact import
> paths already used by `RuleImportDialog.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/brief/BriefBuilder.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/brief/BriefBuilder.tsx src/components/brief/BriefBuilder.test.tsx
git commit -m "feat(brief): BriefBuilder interview dialog (resumable, doc pre-fill)"
```

---

### Task 12: Living Memory "Translation Brief" section + wire it up

**Files:**
- Create: `src/components/brief/BriefSection.tsx`
- Modify: `src/components/LivingMemoryPage.tsx` (render `BriefSection` above the existing sections, pass settings + patch + author + provider settings)
- Test: `src/components/brief/BriefSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/brief/BriefSection.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { BriefSection } from "./BriefSection"
import { emptyBrief, withL1ForTest } from "@/lib/brief/brief-test-helpers" // see note

vi.mock("@/hooks/useTranslationBrief", () => ({
  useTranslationBrief: () => ({ save: vi.fn(), attachL1: vi.fn() }),
  buildSavePayload: (p: unknown) => p,
  withGeneratedL1: (p: unknown) => p,
}))

describe("BriefSection", () => {
  it("shows a create CTA when there is no brief", () => {
    render(<BriefSection brief={undefined} canEdit onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.getByRole("button", { name: /create brief/i })).toBeTruthy()
  })
  it("shows an 'out of date' badge when the L1 is stale", () => {
    render(<BriefSection brief={emptyBrief("a")} canEdit onEdit={() => {}} onGenerate={() => {}} stale />)
    expect(screen.getByText(/out of date/i)).toBeTruthy()
  })
  it("hides edit affordances for non-maintainers", () => {
    render(<BriefSection brief={emptyBrief("a")} canEdit={false} onEdit={() => {}} onGenerate={() => {}} stale={false} />)
    expect(screen.queryByRole("button", { name: /edit brief/i })).toBeNull()
  })
})
```

> NOTE: keep `BriefSection` a **pure presentational** component (props only:
> `brief`, `canEdit`, `stale`, `onEdit`, `onGenerate`, optional `l1Preview`).
> That makes the test above need no provider mocks — delete the
> `useTranslationBrief` mock and the `brief-test-helpers` import and use
> `emptyBrief` from `@/lib/brief/brief` directly. (The version above shows the
> intent; simplify to props-only in the real test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/brief/BriefSection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the presentational section**

```tsx
// src/components/brief/BriefSection.tsx
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { TranslationBrief } from "@/lib/brief/types"
import { briefStatus } from "@/lib/brief/brief"

export interface BriefSectionProps {
  brief: TranslationBrief | undefined
  canEdit: boolean
  stale: boolean
  onEdit: () => void
  onGenerate: () => void
}

export function BriefSection(props: BriefSectionProps) {
  const { brief, canEdit, stale, onEdit, onGenerate } = props
  const status = briefStatus(brief)

  return (
    <section className="px-4 py-3 max-w-2xl mx-auto w-full">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold">Translation brief</h2>
        <Badge variant="secondary" className="text-[10px] capitalize">{status}</Badge>
        {brief && stale && <Badge variant="outline" className="text-[10px]">Summary out of date</Badge>}
      </div>

      {status === "none" ? (
        <div className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
          <p className="mb-3">
            Capture this project's purpose, audience, and standards so the AI drafts to your brief.
          </p>
          {canEdit && <Button size="sm" onClick={onEdit}>Create brief</Button>}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 p-4 space-y-3">
          {brief?.l1Summary ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{brief.l1Summary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No summary generated yet.</p>
          )}
          {canEdit && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onEdit}>Edit brief</Button>
              <Button size="sm" variant={stale ? "default" : "ghost"} onClick={onGenerate}>
                {brief?.l1Summary ? "Regenerate summary" : "Generate summary"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Wire it into LivingMemoryPage**

In `src/components/LivingMemoryPage.tsx`, inside `LivingMemoryPage()`:
- Read the brief: `const brief = settings.translationBrief ?? project?.translationBrief`.
- Compute `const stale = brief ? isL1Stale(brief) : false` (import `isL1Stale`).
- Manage `const [builderOpen, setBuilderOpen] = useState(false)`.
- Build a controller via `useTranslationBrief({ brief, author, patch: patchSettings })`.
- Get completion settings for generation: the page already has `session`; obtain `CompletionSettings` the same way `useCompletion`'s caller does (from the project's `completionSettings`). Reuse `effectiveCompletionSettings(project)` if such a helper exists; otherwise read `project?.completionSettings`.
- Render `<BriefSection brief={brief} canEdit={canEdit} stale={stale} onEdit={() => setBuilderOpen(true)} onGenerate={handleGenerate} />` immediately after the page header block (after line ~543, before the truncation warning).
- Render `<BriefBuilder open={builderOpen} ... />` with:
  - `onSaveDraft={(draft) => save(brief ?? emptyBrief(author), draft)}`
  - `onGenerateL1={async (draft) => { const saved = await save(brief ?? emptyBrief(author), draft); const l1 = await generateL1Summary(saved, completionSettings, session); await attachL1(saved, l1, completionSettings.model) }}`
  - `onHelpDraft={async (fieldId, draft) => draftField(fieldId, draft, completionSettings, session)}` (the per-field LLM draft helper added in Task 13; import `draftField` from `@/lib/brief/brief-generator`)
  - `onExtractDocument={(text) => { const chk = checkInputSize(text); if (!chk.ok) throw new Error(chk.message); return extractBriefFromDocument(text, completionSettings, session) }}`
- `handleGenerate` (the section button) opens the builder OR, if the brief is already complete, runs generation directly on the current `brief`.

Imports to add at the top of `LivingMemoryPage.tsx`:
```ts
import { useState } from "react" // if not already imported
import { BriefSection } from "@/components/brief/BriefSection"
import { BriefBuilder } from "@/components/brief/BriefBuilder"
import { emptyBrief, isL1Stale } from "@/lib/brief/brief"
import { useTranslationBrief } from "@/hooks/useTranslationBrief"
import { generateL1Summary, extractBriefFromDocument } from "@/lib/brief/brief-generator"
import { checkInputSize } from "@/lib/rules/rule-extractor"
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/components/brief`
Expected: PASS.
Run: `pnpm tsc -p tsconfig.json --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/brief/BriefSection.tsx src/components/brief/BriefSection.test.tsx src/components/LivingMemoryPage.tsx
git commit -m "feat(brief): Living Memory brief section + BriefBuilder wiring"
```

---

### Task 13: Per-field draft helper (`draftField`)

**Files:**
- Modify: `src/lib/brief/brief-generator.ts` (add `draftField`)
- Test: `src/lib/brief/brief-generator.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
import { draftField } from "./brief-generator"

describe("draftField", () => {
  it("asks the model to draft one field using the other answers as context", async () => {
    vi.mocked(complete).mockResolvedValue("Young, unchurched readers aged 15-25.")
    const out = await draftField("audience", { parameters: { purpose: "Evangelistic" }, freeformNotes: "" }, settings, null)
    expect(out).toBe("Young, unchurched readers aged 15-25.")
    const sys = vi.mocked(complete).mock.calls.at(-1)![0].messages[0].content
    expect(sys).toContain("Audience / addressees") // field label drives the prompt
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/brief/brief-generator.test.ts`
Expected: FAIL — `draftField` not exported.

- [ ] **Step 3: Implement**

```ts
// add to src/lib/brief/brief-generator.ts
import type { BriefDraft } from "@/hooks/useTranslationBrief"

/** Draft a single brief field using already-answered fields as context. */
export async function draftField(
  fieldId: string,
  draft: BriefDraft,
  settings: CompletionSettings,
  session: FrontierSession | null = null,
  onLlmCall?: UsageCallback,
): Promise<string> {
  const field = BRIEF_FIELDS.find((f) => f.id === fieldId)
  if (!field) return ""
  const known = BRIEF_FIELDS
    .filter((f) => f.id !== fieldId && (draft.parameters[f.id] ?? "").trim())
    .map((f) => `- ${f.label}: ${draft.parameters[f.id].trim()}`)
    .join("\n")
  const sys = `You are helping a Bible-translation project lead write one section of their translation brief.

Section: ${field.label}
What it should cover: ${field.helperText}

Write a concise, concrete answer for this section only. No preamble, no heading — just the answer text.`
  const user = known
    ? `What the lead has said about other sections:\n${known}\n\nNow draft the "${field.label}" section.`
    : `Draft the "${field.label}" section for a typical project. Keep it concise and editable.`
  const response = await complete({
    settings: { ...settings, maxTokens: Math.min(settings.maxTokens, 512), temperature: 0.4 },
    session,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
  })
  onLlmCall?.({ kind: "brief-draft-field", model: settings.model, provider: settings.provider || "frontier" })
  return response.trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/brief/brief-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/brief/brief-generator.ts src/lib/brief/brief-generator.test.ts
git commit -m "feat(brief): per-field LLM draft helper"
```

---

## Phase 7 — Verification

### Task 14: Full suite + typecheck + manual UI smoke

- [ ] **Step 1: Run the full client test suite**

Run: `pnpm vitest run src/lib/brief src/lib/completion src/lib/sync src/hooks src/components/brief`
Expected: PASS.

- [ ] **Step 2: Run the auth-worker agent tests**

Run: `pnpm --dir auth-worker vitest run src/__tests__/agent-docs-brief.test.ts src/__tests__/agent-schema-card.test.ts src/__tests__/agent-route.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm tsc -p tsconfig.json --noEmit && pnpm build`
Expected: no errors.

- [ ] **Step 4: Manual UI smoke (REQUIRED — use the `verify-dev-change` skill)**

Invoke the `verify-dev-change` skill to drive the local dev stack as the seeded dev user and confirm:
1. Open a project → Living Memory → the "Translation brief" section shows status `none` with a "Create brief" CTA (as maintainer).
2. Create brief → step through 2-3 fields, use "Help me write this" on one, "Save draft" mid-way → reopen → it resumes at the first unanswered field with prior answers intact.
3. Complete all fields → "Save & generate summary" → the section shows the L1 summary and status `complete`.
4. Edit one field and save → the "Summary out of date" badge appears.
5. As a non-maintainer (or with role below 600), the section is read-only (no Edit/Create buttons, textarea read-only).
6. Generate a completion on a cell and confirm via network/logs that the system prompt carries the brief block (it appears in the outgoing chat request).

Capture a screenshot of the section in `complete` state as proof.

- [ ] **Step 5: Commit any fixes from the smoke test**

```bash
git add -A
git commit -m "fix(brief): address issues found in UI smoke test"
```

---

## Self-review notes (author)

- **Spec coverage:** parameter schema (Task 1) · data model (Task 3) · authoring flow incl. resumability/doc-upload/freeform (Tasks 10-13) · L1 always-injected into completion (Tasks 6-7) · L1 in agent card + L2 via docs (Tasks 8-9) · UI in Living Memory, maintainer-gated read-only for others (Task 12) · staleness + status derivation (Task 2) · testing (each task) — all covered.
- **Out of scope honored:** no brief history, `systemPrompt` untouched, single markdown L2, one brief per project.
- **Naming consistency:** `TranslationBrief`, `briefSummary` (prompt option + agent ctx + SELECT alias `brief_summary`), `buildBriefBlock`, `isL1Stale`, `briefStatus`, `assembleL2Markdown`, `generateL1Summary`, `extractBriefFromDocument`, `draftField`, `buildSavePayload`/`withGeneratedL1` — used identically across tasks.
- **Known integration risk:** exact UI primitive import paths and the `ProjectWorkspace`/`LivingMemoryPage` settings/`completionSettings` accessors are verified by the implementer against the live files (Tasks 7, 12 call this out explicitly) rather than guessed.
