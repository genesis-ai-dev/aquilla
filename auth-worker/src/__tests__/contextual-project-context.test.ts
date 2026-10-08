// Project context + readiness. WHY: this closes the gap that made autopilot's
// output amateur rather than professional — the project's KEY TERMS were
// compiled into rules client-side only, so no server-side draft prompt and no
// server-side lint ever saw them. Autopilot could be punished for missing an
// approved rendering it was never shown.
//
// Each test pins one of the properties that make the fix trustworthy:
//   1. The any-of test ("use ANY approved rendering") is stated correctly,
//      because getting it wrong makes a check that silently never fires. The
//      full verdict semantics are the editor's, pinned row by row in
//      terminology-lint-parity.test.ts (AQU-1711). Hit ids stay the client's,
//      so findings remain attributable.
//   2. Term guidance is scoped to the span. A 900-entry termbase in a prompt
//      buries the eight entries that matter for the passage in front of it.
//   3. Readiness reports gaps honestly. A run with no context still produces
//      confident output and still reports spans staged, so the checklist is
//      the only thing that can tell a PM the run was premature.
//   4. Key terms are read where the editor reads them: the `concepts` table
//      (AQU-1710). The migration deletes the old settings key, so a loader
//      that reads only the key gives autopilot an empty termbase.

import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import {
  isRegisteredTargetLane,
  loadProjectContext,
  lintTerminology,
  termGuidanceForSpan,
  MAX_TERMS_PER_SPAN,
  type Concept,
} from "../lib/contextual/project-context"
import { computeContextReadiness } from "../lib/contextual/readiness"
import { rulesForLane } from "../lib/agent/lint"
import { seedUser } from "./helpers/db"

const db = env.AQUILLA_PG

function concept(overrides: Partial<Concept> & Pick<Concept, "id" | "sourceTerm">): Concept {
  return { renderings: [], status: "active", ...overrides }
}

/** Language keys live in the settings JSON. Migration 0156 dropped the
 *  generated columns that used to project them, so this writes the blob only. */
async function seedSettings(projectId: string, settings: unknown) {
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES (?, ?)
       ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    )
    .bind(projectId, JSON.stringify(settings))
    .run()
}

/** One row of the `concepts` projection, as `term.*` events leave it. */
async function seedConcept(
  projectId: string,
  row: {
    id: string
    sourceTerm: string
    renderings: { rendering: string; status: string }[]
    status?: string
    caseSensitive?: boolean
    match?: unknown
    createdAt?: number
    deletedAt?: number
  },
) {
  await db
    .prepare(
      `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status,
                             case_sensitive, match_options, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      projectId,
      row.sourceTerm,
      JSON.stringify(row.renderings),
      row.status ?? "active",
      row.caseSensitive ? 1 : 0,
      row.match === undefined ? null : JSON.stringify(row.match),
      row.createdAt ?? 1,
      row.createdAt ?? 1,
      row.deletedAt ?? null,
    )
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
    // AQU-1595: a null lane language does not read settings.sourceLanguage
    // or settings.targetLanguage. These keys are still in the blob.
    expect(ctx.sourceLanguage).toBeUndefined()
    expect(ctx.targetLanguage).toBeUndefined()
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
    // AQU-1721: a subscription counts only while its termbase is published and
    // in the subscriber's org (the editor's rule), so both projects need rows.
    // termbase-subscription-gate.test.ts covers the cases that do not count.
    await seedUser(1, "owner")
    await db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)").run()
    await db
      .prepare(
        `INSERT INTO projects (id, name, org_id, created_by, org_published_termbase) VALUES
          ('proj-upstream', 'Upstream', 1, 1, TRUE),
          ('proj-subscriber', 'Subscriber', 1, 1, FALSE)`,
      )
      .run()
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

  // AQU-1710: since 2026-09-04 term writes land in the `concepts` table, and
  // the migration deletes the settings key once it has copied it. A loader
  // that read only the key drafted every migrated project with no key terms.
  it("reads a migrated project's key terms from the concepts table", async () => {
    await seedSettings("proj-ctx-migrated", { sourceLanguage: "English", targetLanguage: "Spanish" })
    await seedConcept("proj-ctx-migrated", {
      id: "aqu1710-grace",
      sourceTerm: "grace",
      renderings: [
        { rendering: "gracia", status: "preferred" },
        { rendering: "suerte", status: "forbidden" },
      ],
    })
    // Decisions in progress and deleted terms constrain nothing.
    await seedConcept("proj-ctx-migrated", { id: "aqu1710-draft", sourceTerm: "covenant", renderings: [], status: "draft" })
    await seedConcept("proj-ctx-migrated", {
      id: "aqu1710-deleted",
      sourceTerm: "faith",
      renderings: [{ rendering: "fe", status: "preferred" }],
      deletedAt: 2,
    })

    const ctx = await loadProjectContext(db, "proj-ctx-migrated")
    expect(ctx.concepts.map((c) => c.id)).toEqual(["aqu1710-grace"])
    // What loading them is for: autopilot's lint now raises the violations
    // the editor marks on the same draft.
    expect(lintTerminology(ctx.concepts, "by grace alone", "sólo por suerte").map((h) => h.ruleId)).toEqual([
      "term:aqu1710-grace:approved",
      "term:aqu1710-grace:forbidden:suerte",
    ])
  })

  it("carries case sensitivity and validated match options the way the editor reads them", async () => {
    await seedSettings("proj-ctx-options", {})
    await seedConcept("proj-ctx-options", {
      id: "aqu1710-lord",
      sourceTerm: "LORD",
      renderings: [{ rendering: "SEÑOR", status: "preferred" }],
      caseSensitive: true,
      // An unknown key is dropped rather than handed to the matcher.
      match: { forms: ["LORD's"], excludedForms: ["lordship"], bogus: 1 },
    })

    const [lord] = (await loadProjectContext(db, "proj-ctx-options")).concepts
    expect(lord.caseSensitive).toBe(true)
    expect(lord.match).toEqual({ forms: ["LORD's"], excludedForms: ["lordship"] })
  })

  it("ignores a leftover settings blob once the table has live rows", async () => {
    await seedSettings("proj-ctx-both", {
      terminology: [
        { id: "aqu1710-stale", sourceTerm: "grace", status: "active", renderings: [{ rendering: "favor", status: "preferred" }] },
      ],
    })
    await seedConcept("proj-ctx-both", {
      id: "aqu1710-live",
      sourceTerm: "grace",
      renderings: [{ rendering: "gracia", status: "preferred" }],
    })

    const ctx = await loadProjectContext(db, "proj-ctx-both")
    expect(ctx.concepts.map((c) => c.id)).toEqual(["aqu1710-live"])
  })

  it("falls back to the settings blob while the table has no live rows, as the editor does", async () => {
    await seedSettings("proj-ctx-unmigrated", {
      terminology: [
        { id: "aqu1710-blob", sourceTerm: "grace", status: "active", renderings: [{ rendering: "gracia", status: "preferred" }] },
      ],
    })
    // A deleted row is not a live row, so it does not stop the fallback.
    await seedConcept("proj-ctx-unmigrated", { id: "aqu1710-gone", sourceTerm: "faith", renderings: [], deletedAt: 2 })

    const ctx = await loadProjectContext(db, "proj-ctx-unmigrated")
    expect(ctx.concepts.map((c) => c.id)).toEqual(["aqu1710-blob"])
  })

  it("drafts without local key terms, and says so, when the concepts read fails", async () => {
    await seedSettings("proj-ctx-concepts-down", {
      sourceLanguage: "English",
      terminology: [{ id: "aqu1710-blob-down", sourceTerm: "grace", status: "active", renderings: [] }],
    })
    // AQU-1595: the language is read off the lane row, not settings.sourceLanguage.
    await db
      .prepare(
        `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
         VALUES ('ctxdnsrc', 'proj-ctx-concepts-down', 'source', 'English', NULL, 0)`,
      )
      .run()
    const conceptsDown = {
      prepare: (query: string) => {
        if (query.includes("FROM concepts")) throw new Error("concepts unavailable")
        return db.prepare(query)
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const ctx = await loadProjectContext(conceptsDown, "proj-ctx-concepts-down")
      // The run still gets the rest of its context. The blob is not served in
      // place of the table: the editor would not show it either.
      expect(ctx.sourceLanguage).toBe("English")
      expect(ctx.concepts).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("proj-ctx-concepts-down"), "concepts unavailable")
    } finally {
      warn.mockRestore()
    }
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
    expect(byId.get("brief")?.href).toBe("memory/brief")
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

// AQU-609: lane-scoped rules cross the SPA→worker boundary as plain settings
// JSON. WHY: the SPA writes `scope: "lane"` + `lane` on TranslationRule; if
// parsing dropped those fields or the tick-side filter mismatched the client
// predicate, a French-only rule would either lint every lane's drafts (false
// violations) or none (silent non-enforcement).
describe("isRegisteredTargetLane", () => {
  it("matches the registered tag exactly, not the language", async () => {
    await seedSettings("proj-ctx-reg", { targetLanes: ["Spanish"], archivedLanes: [] })
    expect(await isRegisteredTargetLane(db, "proj-ctx-reg", "Spanish")).toBe(true)
    expect(await isRegisteredTargetLane(db, "proj-ctx-reg", "es")).toBe(false)
    expect(await isRegisteredTargetLane(db, "proj-ctx-reg", "")).toBe(true)
  })
})

describe("lane-scoped authored rules (AQU-609)", () => {
  it("passes scope/lane through loadProjectContext and rulesForLane filters by run lane", async () => {
    await seedSettings("proj-ctx-lanes", {
      targetLanes: ["fr", "es"],
      rules: [
        // Real producer shapes: what RuleEditor/useRules write into settings.
        { id: "all", name: "Everywhere", enabled: true, severity: "minor", source: "user", scope: "project", check: { type: "target-forbids", targetPattern: "x" } },
        { id: "fr-only", name: "French only", enabled: true, severity: "minor", source: "user", scope: "lane", lane: "fr", check: { type: "target-forbids", targetPattern: "y" } },
        { id: "default-only", name: "Default lane only", enabled: true, severity: "minor", source: "user", scope: "lane", lane: "", check: { type: "target-forbids", targetPattern: "z" } },
      ],
    })

    const ctx = await loadProjectContext(db, "proj-ctx-lanes")
    // Parsing must not strip the scoping fields.
    expect(ctx.authoredRules.map((r) => [r.id, r.scope, r.lane])).toEqual([
      ["all", "project", undefined],
      ["fr-only", "lane", "fr"],
      ["default-only", "lane", ""],
    ])

    expect(rulesForLane(ctx.authoredRules, "fr").map((r) => r.id)).toEqual(["all", "fr-only"])
    expect(rulesForLane(ctx.authoredRules, "es").map((r) => r.id)).toEqual(["all"])
    expect(rulesForLane(ctx.authoredRules, "").map((r) => r.id)).toEqual(["all", "default-only"])
  })
})
