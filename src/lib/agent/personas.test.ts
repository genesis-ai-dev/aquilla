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
import { PROCESS_NODE_IDS, type ProcessRegion } from "@/lib/contextual/process-graph"
import { en, type MessageKey } from "@/lib/i18n/messages/en"
import {
  AGENT_PERSONA_CAPABILITIES,
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

/**
 * Capability metadata backs the agent cards — the app's answer to "what is
 * this thing actually allowed to do to my project?". A card that under-reports
 * is worse than no card: it is a transparency surface that quietly lies. So
 * these tests are about TOTALITY and HONESTY rather than presentation:
 * every teammate discloses something, every disclosed capability names a real
 * tool or pipeline node, every chat tool the harness can call is disclosed by
 * exactly the persona that speaks for it, and the writes line keeps the
 * approval gate legible.
 */
describe("persona capabilities (agent cards)", () => {
  /** Every message key the cards render, so one loop can check they resolve. */
  function keysFor(id: (typeof AGENT_PERSONA_IDS)[number]): MessageKey[] {
    const caps = AGENT_PERSONA_CAPABILITIES[id]
    return [
      AGENT_PERSONAS[id].nameKey,
      AGENT_PERSONAS[id].taglineKey,
      caps.writeKey,
      ...caps.tools.flatMap((tool) => [tool.labelKey, tool.descriptionKey]),
      ...caps.reads.flatMap((read) => [read.labelKey, read.descriptionKey]),
    ]
  }

  it("gives every teammate something to disclose", () => {
    for (const id of AGENT_PERSONA_IDS) {
      const caps = AGENT_PERSONA_CAPABILITIES[id]
      expect(caps.tools.length, `${id} discloses no tools`).toBeGreaterThan(0)
      expect(caps.reads.length, `${id} discloses no reads`).toBeGreaterThan(0)
    }
  })

  it("resolves every message key the card renders to non-empty English", () => {
    for (const id of AGENT_PERSONA_IDS) {
      for (const key of keysFor(id)) {
        const value = en[key]
        expect(typeof value, `${key} is missing from the English catalog`).toBe("string")
        expect(String(value).trim(), `${key} is empty`).not.toBe("")
      }
    }
  })

  it("keeps label and description distinct for every capability", () => {
    // A description that merely repeats the label teaches nothing — the card
    // exists to explain, not to name twice.
    for (const id of AGENT_PERSONA_IDS) {
      const caps = AGENT_PERSONA_CAPABILITIES[id]
      for (const cap of [...caps.tools, ...caps.reads]) {
        expect(cap.labelKey, `${id}/${cap.id}`).not.toBe(cap.descriptionKey)
        expect(en[cap.labelKey], `${id}/${cap.id}`).not.toBe(en[cap.descriptionKey])
      }
    }
  })

  it("names a real tool or a real pipeline node for every capability", () => {
    // The card's credibility rests on this: each entry stands for something
    // the machinery genuinely has, not a hand-written claim.
    const TOOLS: ToolKind[] = [
      "read", "examples", "search", "draft", "emit", "sql", "docs", "aquifer",
    ]
    for (const id of AGENT_PERSONA_IDS) {
      for (const tool of AGENT_PERSONA_CAPABILITIES[id].tools) {
        if (tool.source.kind === "tool") {
          expect(TOOLS, `${id}/${tool.id}`).toContain(tool.source.tool)
        } else {
          expect(PROCESS_NODE_IDS, `${id}/${tool.id}`).toContain(tool.source.node)
        }
      }
    }
  })

  it("discloses every chat tool exactly once, filed under the persona that speaks for it", () => {
    // The strong contract: the harness's ToolKind union, the attribution rule
    // in personaForToolKind, and what the cards show must not drift apart. A
    // tool added to the protocol without a card entry fails here.
    const disclosed = new Map<ToolKind, (typeof AGENT_PERSONA_IDS)[number]>()
    for (const id of AGENT_PERSONA_IDS) {
      for (const tool of AGENT_PERSONA_CAPABILITIES[id].tools) {
        if (tool.source.kind !== "tool") continue
        expect(disclosed.has(tool.source.tool), `${tool.source.tool} disclosed twice`).toBe(false)
        disclosed.set(tool.source.tool, id)
      }
    }

    const TOOLS: ToolKind[] = [
      "read", "examples", "search", "draft", "emit", "sql", "docs", "aquifer",
    ]
    expect([...disclosed.keys()].sort()).toEqual([...TOOLS].sort())
    for (const [tool, id] of disclosed) {
      expect(id, `${tool} is attributed to ${personaForToolKind(tool)} but carded under ${id}`)
        .toBe(personaForToolKind(tool))
    }
  })

  it("gives the Reviewer the three verifier stances and the rules lint", () => {
    // The Reviewer calls no chat tools — it IS the autopilot's verification
    // stretch. Pin the four passes so the card can't quietly drop one.
    const nodes = AGENT_PERSONA_CAPABILITIES.reviewer.tools.map((tool) =>
      tool.source.kind === "autopilot" ? tool.source.node : null,
    )
    expect(nodes).toEqual([
      "verify_force",
      "verify_ambiguity",
      "verify_naturalness",
      "lint_rules",
    ])
  })

  it("keeps the approval gate legible in every writes line", () => {
    // The wording discipline the agent namespace documents: a card may say a
    // change is STAGED and awaits a human, never that it is already applied.
    for (const id of AGENT_PERSONA_IDS) {
      const sentence = String(en[AGENT_PERSONA_CAPABILITIES[id].writeKey])
      expect(sentence, `${id} writes line omits the staged state`).toMatch(/stage[sd]?\b/i)
      expect(sentence, `${id} writes line omits the human decision`).toMatch(/approve/i)
    }
  })

  it("builds project-scoped routes for the state it claims to read", () => {
    // The links are the proof of the claim, so they must be real in-app paths
    // under the project the card was opened from (routes in App.tsx).
    const routes = AGENT_PERSONA_IDS.flatMap((id) =>
      AGENT_PERSONA_CAPABILITIES[id].reads
        .filter((read) => read.route !== null)
        .map((read) => read.route!("proj-1")),
    )
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      expect(route).toMatch(/^\/project\/proj-1\//)
    }
    expect(new Set(routes)).toEqual(
      new Set([
        "/project/proj-1/memory/brief",
        "/project/proj-1/memory/instructions",
        "/project/proj-1/terminology",
        "/project/proj-1/memory",
        "/project/proj-1/memory/quality",
      ]),
    )
  })
})
