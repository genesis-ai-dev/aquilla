// Project context + readiness. WHY: this closes the gap that made autopilot's
// output amateur rather than professional — the project's KEY TERMS were
// compiled into rules client-side only, so no server-side draft prompt and no
// server-side lint ever saw them. Autopilot could be punished for missing an
// approved rendering it was never shown.
//
// Each test pins one of the three properties that makes the fix trustworthy:
//   1. The any-of test ("use ANY approved rendering") is stated correctly.
//      It cannot be expressed as a single-pattern lint rule, and the failure
//      mode of getting it wrong is a check that silently never fires — the
//      worst possible outcome for a check that exists to catch silent drift.
//      Hit ids stay the client's, so findings remain attributable.
//   2. Term guidance is scoped to the span. A 900-entry termbase in a prompt
//      buries the eight entries that matter for the passage in front of it.
//   3. Readiness reports gaps honestly. A run with no context still produces
//      confident output and still reports spans staged, so the checklist is
//      the only thing that can tell a PM the run was premature.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  loadProjectContext,
  lintTerminology,
  termGuidanceForSpan,
  MAX_TERMS_PER_SPAN,
  type Concept,
} from "../lib/contextual/project-context"
import { computeContextReadiness } from "../lib/contextual/readiness"

const db = env.AQUILLA_PG

function concept(overrides: Partial<Concept> & Pick<Concept, "id" | "sourceTerm">): Concept {
  return { renderings: [], status: "active", ...overrides }
}

/** `source_language`/`target_language` are GENERATED columns over the settings
 *  JSON — they are set by putting the keys in the blob, never by insert. */
async function seedSettings(projectId: string, settings: unknown) {
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES (?, ?)
       ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    )
    .bind(projectId, JSON.stringify(settings))
    .run()
}

// ── Terminology checking ────────────────────────────────────────────────────

describe("lintTerminology", () => {
  const graceConcepts = [
    concept({
      id: "c-grace",
      sourceTerm: "grace",
      renderings: [
        { rendering: "gracia", status: "preferred" },
        { rendering: "favor", status: "admitted" },
        { rendering: "suerte", status: "forbidden" },
      ],
    }),
  ]

  it("passes a draft that uses ANY approved rendering", () => {
    // The any-of case is exactly what a single-pattern lint rule cannot state,
    // which is why this check does not go through lintDraft.
    expect(lintTerminology(graceConcepts, "by grace alone", "sólo por gracia")).toHaveLength(0)
    expect(lintTerminology(graceConcepts, "by grace alone", "sólo por favor")).toHaveLength(0)
  })

  it("flags a draft that renders the term some other way", () => {
    const hits = lintTerminology(graceConcepts, "by grace alone", "sólo por buena onda")
    expect(hits).toHaveLength(1)
    expect(hits[0].ruleId).toBe("term:c-grace:approved")
    expect(hits[0].message).toContain("gracia")
  })

  it("flags a forbidden rendering even alongside an approved one", () => {
    const hits = lintTerminology(graceConcepts, "by grace alone", "gracia o suerte")
    expect(hits.map((h) => h.ruleId)).toEqual(["term:c-grace:forbidden:suerte"])
  })

  it("uses rule ids the client's violations inbox can attribute to the concept", () => {
    const hits = lintTerminology(graceConcepts, "by grace alone", "buena onda")
    expect(hits[0].ruleId.startsWith("term:c-grace:")).toBe(true)
  })

  it("only constrains cells whose SOURCE bears the term", () => {
    expect(lintTerminology(graceConcepts, "in the beginning", "al principio")).toHaveLength(0)
  })

  it("ignores concepts with no decisions and empty drafts", () => {
    const undecided = [concept({ id: "c1", sourceTerm: "grace", renderings: [] })]
    expect(lintTerminology(undecided, "by grace", "lo que sea")).toHaveLength(0)
    expect(lintTerminology(graceConcepts, "by grace", "")).toHaveLength(0)
  })
})

// ── Span-scoped term guidance ───────────────────────────────────────────────

describe("termGuidanceForSpan", () => {
  const concepts = [
    concept({
      id: "c-grace",
      sourceTerm: "grace",
      renderings: [
        { rendering: "gracia", status: "preferred" },
        { rendering: "suerte", status: "forbidden" },
      ],
      notes: "Never the fortune sense.",
    }),
    concept({
      id: "c-covenant",
      sourceTerm: "covenant",
      renderings: [{ rendering: "pacto", status: "preferred" }],
    }),
  ]

  it("returns only the terms that actually appear in this passage", () => {
    const guidance = termGuidanceForSpan(concepts, ["Saved by grace, not by works."])
    expect(guidance.map((g) => g.sourceTerm)).toEqual(["grace"])
    expect(guidance[0].preferred).toEqual(["gracia"])
    expect(guidance[0].forbidden).toEqual(["suerte"])
    expect(guidance[0].notes).toBe("Never the fortune sense.")
  })

  it("matches case-insensitively and across wildcards, like the rule engine", () => {
    expect(termGuidanceForSpan(concepts, ["GRACE abounded"])).toHaveLength(1)
    const wildcard = [concept({
      id: "c-w",
      sourceTerm: "grac*",
      renderings: [{ rendering: "gracia", status: "preferred" }],
    })]
    expect(termGuidanceForSpan(wildcard, ["he was gracious"])).toHaveLength(1)
  })

  it("orders by first appearance so a truncated list keeps the most relevant terms", () => {
    const guidance = termGuidanceForSpan(concepts, ["The covenant of grace"])
    expect(guidance.map((g) => g.sourceTerm)).toEqual(["covenant", "grace"])
  })

  it("caps the list so one prompt cannot carry an entire termbase", () => {
    const many = Array.from({ length: MAX_TERMS_PER_SPAN + 10 }, (_, i) =>
      concept({
        id: `c${i}`,
        sourceTerm: `term${i}`,
        renderings: [{ rendering: `r${i}`, status: "preferred" }],
      }),
    )
    const text = many.map((c) => c.sourceTerm).join(" ")
    expect(termGuidanceForSpan(many, [text])).toHaveLength(MAX_TERMS_PER_SPAN)
  })

  it("drops concepts with no decisions recorded — they constrain nothing", () => {
    const undecided = [concept({ id: "c-x", sourceTerm: "grace", renderings: [] })]
    expect(termGuidanceForSpan(undecided, ["by grace"])).toHaveLength(0)
  })

  it("returns nothing for an empty termbase or empty span", () => {
    expect(termGuidanceForSpan([], ["by grace"])).toEqual([])
    expect(termGuidanceForSpan(concepts, [])).toEqual([])
    expect(termGuidanceForSpan(concepts, ["   "])).toEqual([])
  })
})

// ── Loading ─────────────────────────────────────────────────────────────────

describe("loadProjectContext", () => {
  it("reads brief, terminology and rules out of the one settings blob", async () => {
    await seedSettings(
      "proj-ctx-load",
      {
        translationBrief: {
          l1Summary: "A natural-register translation for young readers.",
          parameters: { audience: "Youth", literalness: "Functional", registerNaturalness: "Informal" },
        },
        terminology: [
          {
            id: "c1",
            sourceTerm: "grace",
            status: "active",
            renderings: [{ rendering: "gracia", status: "preferred" }],
          },
          // draft concepts are decisions in progress — they must not constrain.
          { id: "c2", sourceTerm: "covenant", status: "draft", renderings: [] },
        ],
        rules: [
          { id: "r1", name: "No straight quotes", enabled: true, check: { type: "target-forbids", targetPattern: '"' } },
          { id: "r2", name: "Disabled", enabled: false, check: { type: "target-forbids", targetPattern: "x" } },
        ],
        sourceLanguage: "English",
        targetLanguage: "Spanish",
      },
    )

    const ctx = await loadProjectContext(db, "proj-ctx-load")
    expect(ctx.sourceLanguage).toBe("English")
    expect(ctx.targetLanguage).toBe("Spanish")
    expect(ctx.projectBriefL1).toContain("young readers")
    expect(ctx.briefParameters.audience).toBe("Youth")
    expect(ctx.concepts.map((c) => c.id)).toEqual(["c1"])
    expect(ctx.authoredRules.map((r) => r.id)).toEqual(["r1"])
  })

  it("degrades to empty rather than throwing on a project with no settings row", async () => {
    const ctx = await loadProjectContext(db, "proj-that-does-not-exist")
    expect(ctx.concepts).toEqual([])
    expect(ctx.authoredRules).toEqual([])
    expect(ctx.briefParameters).toEqual({})
  })

  it("survives a corrupt settings blob without failing the run", async () => {
    await seedSettings("proj-ctx-corrupt", { terminology: "not-an-array", rules: 42, translationBrief: 7 })
    const ctx = await loadProjectContext(db, "proj-ctx-corrupt")
    expect(ctx.concepts).toEqual([])
    expect(ctx.authoredRules).toEqual([])
    expect(ctx.briefParameters).toEqual({})
  })

  it("picks up concepts from a subscribed org termbase", async () => {
    await seedSettings("proj-upstream", {
      terminology: [
        {
          id: "up1",
          sourceTerm: "covenant",
          status: "active",
          renderings: [{ rendering: "pacto", status: "preferred" }],
        },
      ],
    })
    await seedSettings("proj-subscriber", { terminology: [] })
    await db
      .prepare(
        `INSERT INTO project_termbase_subscriptions (project_id, termbase_project_id, priority)
         VALUES (?, ?, 0) ON CONFLICT DO NOTHING`,
      )
      .bind("proj-subscriber", "proj-upstream")
      .run()

    const ctx = await loadProjectContext(db, "proj-subscriber")
    expect(ctx.concepts.map((c) => c.id)).toContain("up1")
  })
})

// ── Readiness ───────────────────────────────────────────────────────────────

const bareContext = {
  briefParameters: {},
  concepts: [],
  authoredRules: [],
}

describe("computeContextReadiness", () => {
  it("names every gap on a project that has set nothing up", () => {
    const r = computeContextReadiness({
      context: bareContext,
      validatedExamples: 0,
      untranslatedCells: 500,
    })
    expect(r.ready).toBe(false)
    // Terminology, brief and examples are the three that change the WORDING.
    expect(r.blockingGaps).toBe(3)
    const byId = new Map(r.items.map((i) => [i.id, i]))
    expect(byId.get("terminology")?.level).toBe("missing")
    expect(byId.get("terminology")?.href).toBe("terminology")
    expect(byId.get("brief")?.level).toBe("missing")
    expect(byId.get("brief")?.href).toBe("memory")
    expect(byId.get("examples")?.level).toBe("missing")
  })

  it("reports ready once the three wording inputs exist", () => {
    const r = computeContextReadiness({
      context: {
        ...bareContext,
        sourceLanguage: "English",
        targetLanguage: "Spanish",
        projectBriefL1: "A natural-register translation.",
        briefParameters: { audience: "a", literalness: "b", registerNaturalness: "c", keyTerms: "d" },
        concepts: Array.from({ length: 12 }, (_, i) =>
          concept({
            id: `c${i}`,
            sourceTerm: `t${i}`,
            renderings: [{ rendering: `r${i}`, status: "preferred" }],
          }),
        ),
      },
      validatedExamples: 40,
      untranslatedCells: 100,
    })
    expect(r.ready).toBe(true)
    expect(r.blockingGaps).toBe(0)
  })

  it("counts only concepts that actually carry an approved rendering", () => {
    const r = computeContextReadiness({
      context: {
        ...bareContext,
        // Recorded, but no decision made — this constrains nothing, so it must
        // not read as "key terms are set up".
        concepts: [concept({ id: "c1", sourceTerm: "grace", renderings: [] })],
      },
      validatedExamples: 0,
      untranslatedCells: 10,
    })
    expect(r.items.find((i) => i.id === "terminology")?.level).toBe("missing")
  })

  it("calls a thin setup partial rather than ready", () => {
    const r = computeContextReadiness({
      context: {
        ...bareContext,
        briefParameters: { audience: "Youth" },
        concepts: [concept({
          id: "c1",
          sourceTerm: "grace",
          renderings: [{ rendering: "gracia", status: "preferred" }],
        })],
      },
      validatedExamples: 3,
      untranslatedCells: 10,
    })
    const byId = new Map(r.items.map((i) => [i.id, i]))
    expect(byId.get("terminology")?.level).toBe("partial")
    expect(byId.get("brief")?.level).toBe("partial")
    expect(byId.get("examples")?.level).toBe("partial")
    // Partial is not a blocker — nobody is stopped from pressing play.
    expect(r.blockingGaps).toBe(0)
  })

  it.each([
    [1, "1 validated translation to imitate"],
    [8, "8 validated translations to imitate"],
  ] as const)("describes validated target cells truthfully (%s)", (validatedExamples, copy) => {
    const r = computeContextReadiness({
      context: bareContext,
      validatedExamples,
      untranslatedCells: 10,
    })
    const detail = r.items.find((item) => item.id === "examples")?.detail ?? ""
    expect(detail).toContain(copy)
    expect(detail).not.toMatch(/passages? to imitate/)
  })

  it("explains each gap in terms of what it does to the output", () => {
    const r = computeContextReadiness({
      context: bareContext,
      validatedExamples: 0,
      untranslatedCells: 10,
    })
    for (const item of r.items) {
      expect(item.detail.length).toBeGreaterThan(20)
      expect(item.label.length).toBeGreaterThan(0)
    }
  })
})
