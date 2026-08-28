/**
 * personas tests — attribution must be TOTAL: every pipeline region and every
 * chat tool kind maps to a named teammate. An unmapped actor would surface as
 * anonymous activity, which breaks the social framing the team view sells
 * (2026-08-28 social-workspace design). The switches in personas.ts are
 * exhaustive at compile time; these tests pin the intended assignments so a
 * refactor can't silently re-crew the team.
 */

import { describe, it, expect } from "vitest"
import type { ToolKind } from "./protocol"
import type { ProcessRegion } from "@/lib/contextual/process-graph"
import {
  AGENT_PERSONA_IDS,
  AGENT_PERSONAS,
  personaForRegion,
  personaForToolKind,
} from "./personas"

const REGIONS: ProcessRegion[] = ["reading", "drafting", "checking", "staging"]
const TOOLS: ToolKind[] = ["read", "examples", "search", "draft", "emit", "sql", "docs", "aquifer"]

describe("personas", () => {
  it("defines three visually distinct personas", () => {
    expect(AGENT_PERSONA_IDS).toEqual(["drafter", "reviewer", "coordinator"])
    const names = new Set(AGENT_PERSONA_IDS.map((id) => AGENT_PERSONAS[id].nameKey))
    const icons = new Set(AGENT_PERSONA_IDS.map((id) => AGENT_PERSONAS[id].icon))
    const tints = new Set(AGENT_PERSONA_IDS.map((id) => AGENT_PERSONAS[id].textClass))
    expect(names.size).toBe(3)
    expect(icons.size).toBe(3)
    expect(tints.size).toBe(3)
  })

  it("maps every pipeline region to a teammate", () => {
    for (const region of REGIONS) {
      expect(AGENT_PERSONA_IDS).toContain(personaForRegion(region))
    }
    // Reading and drafting are the Drafter's stretch; checks are the
    // Reviewer's; staging/reporting is the Coordinator bringing work to you.
    expect(personaForRegion("reading")).toBe("drafter")
    expect(personaForRegion("drafting")).toBe("drafter")
    expect(personaForRegion("checking")).toBe("reviewer")
    expect(personaForRegion("staging")).toBe("coordinator")
  })

  it("maps every chat tool kind to a teammate", () => {
    for (const tool of TOOLS) {
      expect(AGENT_PERSONA_IDS).toContain(personaForToolKind(tool))
    }
    // Research + drafting activity reads as the Drafter working; project
    // record lookups and staging read as the Coordinator managing the work.
    expect(personaForToolKind("sql")).toBe("coordinator")
    expect(personaForToolKind("emit")).toBe("coordinator")
    expect(personaForToolKind("read")).toBe("drafter")
    expect(personaForToolKind("draft")).toBe("drafter")
  })
})
