import { describe, it, expect } from "vitest"
import type { Concept } from "./types"
import { compileConceptsToRules } from "./compile"
import { addConcept, updateConcept, deleteConcept } from "./store"
import { importConceptsCsv, exportConceptsCsv } from "./csv"
import { importConceptsTbx, exportConceptsTbx } from "./tbx"
import type { ProjectRecord } from "@/lib/parsers/types"

// ---------------------------------------------------------------------------
// Minimal ProjectRecord for store tests
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "es",
    createdAt: "2024-01-01T00:00:00Z",
    files: [],
    members: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Minimal active Concept factory
// ---------------------------------------------------------------------------

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "c1",
    sourceTerm: "spirit",
    renderings: [
      { rendering: "espíritu", status: "preferred" },
      { rendering: "aliento", status: "admitted" },
      { rendering: "ghost", status: "forbidden" },
    ],
    status: "active",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// compile.ts tests
// ---------------------------------------------------------------------------

describe("compileConceptsToRules", () => {
  it("skips draft concepts", () => {
    const rules = compileConceptsToRules([makeConcept({ status: "draft" })])
    expect(rules).toHaveLength(0)
  })

  it("skips deprecated concepts", () => {
    const rules = compileConceptsToRules([makeConcept({ status: "deprecated" })])
    expect(rules).toHaveLength(0)
  })

  it("produces a source-requires-target rule for preferred + admitted renderings", () => {
    const concept = makeConcept({
      renderings: [
        { rendering: "espíritu", status: "preferred" },
        { rendering: "aliento", status: "admitted" },
      ],
    })
    const rules = compileConceptsToRules([concept])
    const approvedRule = rules.find((r) => r.check.type === "source-requires-target")
    expect(approvedRule).toBeDefined()
    expect(approvedRule!.check.type).toBe("source-requires-target")
    if (approvedRule!.check.type === "source-requires-target") {
      // targetPattern should include both approved renderings
      expect(approvedRule!.check.targetPattern).toContain("espíritu")
      expect(approvedRule!.check.targetPattern).toContain("aliento")
    }
  })

  it("produces a target-forbids rule for each forbidden rendering", () => {
    const concept = makeConcept({
      renderings: [
        { rendering: "espíritu", status: "preferred" },
        { rendering: "ghost", status: "forbidden" },
        { rendering: "specter", status: "forbidden" },
      ],
    })
    const rules = compileConceptsToRules([concept])
    const forbiddenRules = rules.filter((r) => r.check.type === "target-forbids")
    expect(forbiddenRules).toHaveLength(2)
    const targetPatterns = forbiddenRules.map((r) => {
      expect(r.check.type).toBe("target-forbids")
      return r.check.type === "target-forbids" ? r.check.targetPattern : ""
    })
    expect(targetPatterns.some((p) => p.includes("ghost"))).toBe(true)
    expect(targetPatterns.some((p) => p.includes("specter"))).toBe(true)
  })

  it("violation detected: preferred rendering missing from target (source contains term)", () => {
    // Verify the compiled rules produce the expected check shape so the rule-engine
    // will flag the violation (rule-engine itself has its own tests).
    const concept = makeConcept({
      renderings: [{ rendering: "espíritu", status: "preferred" }],
    })
    const [rule] = compileConceptsToRules([concept])
    expect(rule.check.type).toBe("source-requires-target")
    if (rule.check.type === "source-requires-target") {
      expect(new RegExp(rule.check.sourcePattern, "i").test("The spirit of God")).toBe(true)
      expect(new RegExp(rule.check.targetPattern, "i").test("wrong rendering")).toBe(false)
      expect(new RegExp(rule.check.targetPattern, "i").test("espíritu")).toBe(true)
    }
  })

  it("admitted rendering satisfies the source-requires-target check", () => {
    const concept = makeConcept({
      renderings: [
        { rendering: "espíritu", status: "preferred" },
        { rendering: "aliento", status: "admitted" },
      ],
    })
    const [rule] = compileConceptsToRules([concept])
    expect(rule.check.type).toBe("source-requires-target")
    if (rule.check.type === "source-requires-target") {
      // target containing only admitted rendering should pass
      expect(new RegExp(rule.check.targetPattern, "i").test("aliento de dios")).toBe(true)
    }
  })

  it("case-insensitive source matching", () => {
    const concept = makeConcept({ sourceTerm: "Spirit" })
    const [rule] = compileConceptsToRules([concept])
    expect(rule.check.type).toBe("source-requires-target")
    if (rule.check.type === "source-requires-target") {
      const re = new RegExp(rule.check.sourcePattern, "gi")
      expect("the SPIRIT moves".match(re)).not.toBeNull()
      expect("the spirit moves".match(re)).not.toBeNull()
    }
  })

  it("forbidden rendering fires target-forbids", () => {
    const concept = makeConcept({
      renderings: [{ rendering: "ghost", status: "forbidden" }],
    })
    const rules = compileConceptsToRules([concept])
    const forbiddenRule = rules.find((r) => r.check.type === "target-forbids")
    expect(forbiddenRule).toBeDefined()
    if (forbiddenRule?.check.type === "target-forbids") {
      expect(new RegExp(forbiddenRule.check.targetPattern, "gi").test("holy ghost")).toBe(true)
    }
  })

  it("concept with only forbidden renderings (no approved) produces no source-requires-target rule", () => {
    const concept = makeConcept({
      renderings: [{ rendering: "ghost", status: "forbidden" }],
    })
    const rules = compileConceptsToRules([concept])
    expect(rules.filter((r) => r.check.type === "source-requires-target")).toHaveLength(0)
    expect(rules.filter((r) => r.check.type === "target-forbids")).toHaveLength(1)
  })

  it("all produced rules are enabled", () => {
    const rules = compileConceptsToRules([makeConcept()])
    expect(rules.every((r) => r.enabled)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// store.ts tests
// ---------------------------------------------------------------------------

describe("addConcept", () => {
  it("adds a concept to an empty project", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      sourceTerm: "love",
      renderings: [{ rendering: "amor", status: "preferred" }],
      status: "active",
    })
    expect(updated.terminology).toHaveLength(1)
    expect(updated.terminology![0].sourceTerm).toBe("love")
    expect(updated.terminology![0].id).toBeTruthy()
    expect(updated.terminology![0].createdAt).toBeTruthy()
  })

  it("appends to existing concepts", () => {
    const project = makeProject({ terminology: [makeConcept()] })
    const updated = addConcept(project, {
      sourceTerm: "faith",
      renderings: [],
      status: "draft",
    })
    expect(updated.terminology).toHaveLength(2)
  })

  it("preserves provided id", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      id: "fixed-id",
      sourceTerm: "grace",
      renderings: [],
      status: "active",
    })
    expect(updated.terminology![0].id).toBe("fixed-id")
  })

  it("does not mutate the original project", () => {
    const project = makeProject({ terminology: [makeConcept()] })
    addConcept(project, { sourceTerm: "x", renderings: [], status: "active" })
    expect(project.terminology).toHaveLength(1)
  })
})

describe("updateConcept", () => {
  it("applies patch to the matching concept", () => {
    const project = makeProject({ terminology: [makeConcept({ id: "c1", status: "draft" })] })
    const updated = updateConcept(project, "c1", { status: "active" })
    expect(updated.terminology![0].status).toBe("active")
    expect(updated.terminology![0].updatedAt).toBeTruthy()
  })

  it("no-ops when id not found", () => {
    const project = makeProject({ terminology: [makeConcept({ id: "c1" })] })
    const updated = updateConcept(project, "no-such-id", { status: "deprecated" })
    expect(updated.terminology![0].status).toBe("active")
  })
})

describe("deleteConcept", () => {
  it("removes the concept with the given id", () => {
    const project = makeProject({
      terminology: [makeConcept({ id: "c1" }), makeConcept({ id: "c2", sourceTerm: "love" })],
    })
    const updated = deleteConcept(project, "c1")
    expect(updated.terminology).toHaveLength(1)
    expect(updated.terminology![0].id).toBe("c2")
  })

  it("returns unchanged project when id not found", () => {
    const project = makeProject({ terminology: [makeConcept({ id: "c1" })] })
    const updated = deleteConcept(project, "missing")
    expect(updated.terminology).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// csv.ts tests
// ---------------------------------------------------------------------------

describe("CSV round-trip", () => {
  it("round-trips a single concept with multiple renderings", () => {
    const concepts: Concept[] = [
      makeConcept({
        sourceTerm: "spirit",
        renderings: [
          { rendering: "espíritu", status: "preferred" },
          { rendering: "aliento", status: "admitted" },
          { rendering: "ghost", status: "forbidden" },
        ],
        notes: "key theological term",
      }),
    ]
    const csv = exportConceptsCsv(concepts)
    const imported = importConceptsCsv(csv)
    expect(imported).toHaveLength(1)
    expect(imported[0].sourceTerm).toBe("spirit")
    expect(imported[0].renderings).toHaveLength(3)
    expect(imported[0].renderings.find((r) => r.status === "preferred")?.rendering).toBe("espíritu")
    expect(imported[0].renderings.find((r) => r.status === "admitted")?.rendering).toBe("aliento")
    expect(imported[0].renderings.find((r) => r.status === "forbidden")?.rendering).toBe("ghost")
    expect(imported[0].notes).toBe("key theological term")
  })

  it("round-trips multiple concepts", () => {
    const concepts: Concept[] = [
      makeConcept({ id: "c1", sourceTerm: "spirit" }),
      makeConcept({ id: "c2", sourceTerm: "grace", renderings: [{ rendering: "gracia", status: "preferred" }] }),
    ]
    const csv = exportConceptsCsv(concepts)
    const imported = importConceptsCsv(csv)
    expect(imported).toHaveLength(2)
    const terms = imported.map((c) => c.sourceTerm)
    expect(terms).toContain("spirit")
    expect(terms).toContain("grace")
  })

  it("handles commas and quotes in values", () => {
    const concepts: Concept[] = [
      {
        id: "c1",
        sourceTerm: 'He said, "hello"',
        renderings: [{ rendering: "dijo, hola", status: "preferred" }],
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]
    const csv = exportConceptsCsv(concepts)
    const imported = importConceptsCsv(csv)
    expect(imported[0].sourceTerm).toBe('He said, "hello"')
    expect(imported[0].renderings[0].rendering).toBe("dijo, hola")
  })

  it("header row is skipped on import", () => {
    const csv = "sourceTerm,rendering,status,notes\nfaith,fe,preferred,"
    const imported = importConceptsCsv(csv)
    expect(imported).toHaveLength(1)
    expect(imported[0].sourceTerm).toBe("faith")
  })

  it("case-insensitive status parsing on import", () => {
    const csv = "sourceTerm,rendering,status,notes\nfaith,fe,Preferred,"
    const imported = importConceptsCsv(csv)
    expect(imported[0].renderings[0].status).toBe("preferred")
  })
})

// ---------------------------------------------------------------------------
// tbx.ts tests
// ---------------------------------------------------------------------------

describe("TBX round-trip", () => {
  it("round-trips a concept with preferred/admitted/forbidden renderings", () => {
    const concepts: Concept[] = [
      makeConcept({
        id: "concept-1",
        sourceTerm: "spirit",
        renderings: [
          { rendering: "espíritu", status: "preferred" },
          { rendering: "aliento", status: "admitted" },
          { rendering: "ghost", status: "forbidden" },
        ],
        notes: "theological key term",
      }),
    ]
    const tbx = exportConceptsTbx(concepts)
    const imported = importConceptsTbx(tbx)
    expect(imported).toHaveLength(1)
    expect(imported[0].sourceTerm).toBe("spirit")
    expect(imported[0].renderings).toHaveLength(3)
    expect(imported[0].renderings.find((r) => r.status === "preferred")?.rendering).toBe("espíritu")
    expect(imported[0].renderings.find((r) => r.status === "admitted")?.rendering).toBe("aliento")
    expect(imported[0].renderings.find((r) => r.status === "forbidden")?.rendering).toBe("ghost")
    expect(imported[0].notes).toBe("theological key term")
  })

  it("round-trips multiple concepts", () => {
    const concepts: Concept[] = [
      makeConcept({ id: "c1", sourceTerm: "spirit" }),
      makeConcept({
        id: "c2",
        sourceTerm: "grace",
        renderings: [{ rendering: "gracia", status: "preferred" }],
      }),
    ]
    const tbx = exportConceptsTbx(concepts)
    const imported = importConceptsTbx(tbx)
    expect(imported).toHaveLength(2)
    expect(imported.map((c) => c.sourceTerm)).toContain("spirit")
    expect(imported.map((c) => c.sourceTerm)).toContain("grace")
  })

  it("handles XML special characters in term values", () => {
    const concepts: Concept[] = [
      {
        id: "c1",
        sourceTerm: "A&B",
        renderings: [{ rendering: "<test>", status: "preferred" }],
        status: "active",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]
    const tbx = exportConceptsTbx(concepts)
    const imported = importConceptsTbx(tbx)
    expect(imported[0].sourceTerm).toBe("A&B")
    expect(imported[0].renderings[0].rendering).toBe("<test>")
  })

  it("exported TBX contains martif root element", () => {
    const tbx = exportConceptsTbx([makeConcept()])
    expect(tbx).toContain("<martif")
    expect(tbx).toContain("<termEntry")
    expect(tbx).toContain("<term>")
  })
})

// ---------------------------------------------------------------------------
// Persistence shape test
// ---------------------------------------------------------------------------

describe("ProjectRecord terminology field", () => {
  it("terminology field is optional on ProjectRecord", () => {
    // This is a compile-time assertion — if ProjectRecord didn't have
    // terminology as optional, the makeProject() calls above would fail tsc.
    const project = makeProject()
    expect(project.terminology).toBeUndefined()
  })

  it("terminology field accepts Concept[]", () => {
    const project = makeProject({ terminology: [makeConcept()] })
    expect(project.terminology).toHaveLength(1)
  })
})
