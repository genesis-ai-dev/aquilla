// Onboarding playbooks (AQU-CMDREG-P1 §4) — three L2 docs topics that sequence
// EXISTING registered commands. The properties worth guarding are the ones a
// later edit could quietly drop: each playbook names real commands in order,
// states its gotchas, and restates the human gate (the agent stages, a person
// applies). They must also stay OUT of the always-resident prompt.
import { describe, it, expect } from "vitest"
import { getCookbook, COOKBOOK_TOPICS } from "../lib/agent/docs"
import { buildSystemPrompt } from "../lib/agent/schema-card"
import { describeCommand } from "../../../db/shared/command-catalog"
import { AGENT_SKILLS } from "../../../db/shared/agent-skills"

const PLAYBOOKS = [
  "playbooks/project-bootstrap",
  "playbooks/qa-sweep",
  "playbooks/first-cycle",
] as const

describe("onboarding playbooks", () => {
  it("registers all three topics", () => {
    for (const topic of PLAYBOOKS) expect(COOKBOOK_TOPICS).toContain(topic)
  })

  it("serves each topic as non-trivial prose", () => {
    for (const topic of PLAYBOOKS) {
      const { ok, text } = getCookbook(topic)
      expect(ok, topic).toBe(true)
      expect(text.length, topic).toBeGreaterThan(400)
      expect(text.startsWith("# Playbook:"), topic).toBe(true)
    }
  })

  it("restates the human gate in every playbook", () => {
    for (const topic of PLAYBOOKS) {
      const text = getCookbook(topic).text
      expect(text, topic).toContain("THE HUMAN GATE")
      expect(text.toLowerCase(), topic).toMatch(/stage[sd]?\b[\s\S]*applie[sd]/i)
    }
  })

  it("names only commands that are actually in the shared catalog", () => {
    // Guards the failure mode that makes a playbook worse than nothing: a
    // confident sequence of commands the engine does not implement.
    const kinds = [
      "SetTranslation",
      "PlanImport",
      "PatchSettings",
      "EmitEvents",
      "LinkMedia",
      "CreateProject",
      "UpdateProjectSettings",
    ]
    const mentioned = new Set<string>()
    for (const topic of PLAYBOOKS) {
      const text = getCookbook(topic).text
      for (const kind of kinds) if (text.includes(kind)) mentioned.add(kind)
    }
    expect(mentioned.size).toBeGreaterThan(0)
    for (const kind of mentioned) expect(describeCommand(kind), kind).not.toBeNull()
  })

  it("bootstrap sequences import → settings → termbase → brief → routing", () => {
    const text = getCookbook("playbooks/project-bootstrap").text
    const order = ["PlanImport", "targetLanes", "terminology", "translationBrief", "assignment.create"]
    let cursor = -1
    for (const marker of order) {
      const at = text.indexOf(marker)
      expect(at, marker).toBeGreaterThan(cursor)
      cursor = at
    }
    // Gotchas that make the difference between a working plan and a rejected one.
    expect(text).toContain("ifMatchVersion")
    expect(text).toContain("sole")
    expect(text).toContain("readiness has no blocking gaps")
  })

  it("qa-sweep filters drafted work and keeps testimony out of bulk", () => {
    const text = getCookbook("playbooks/qa-sweep").text
    expect(text).toContain("filter:'drafted'")
    expect(text).toContain("search(")
    expect(text).toContain("cell.waive")
    expect(text).toContain("cell.validate")
    expect(text.toLowerCase()).toContain("testimony")
    expect(text.toLowerCase()).toContain("one at a time")
  })

  it("first-cycle states the zero-readiness failure mode plainly", () => {
    const text = getCookbook("playbooks/first-cycle").text
    const lower = text.toLowerCase()
    expect(lower).toContain("fluent")
    expect(lower).toContain("generic")
    // draft ONE passage, fill the gaps, re-run the SAME passage.
    expect(text).toContain("ONE")
    expect(text).toContain("SAME passage")
  })

  it("still errors on an unknown topic, and lists the playbooks in the error", () => {
    const { ok, text } = getCookbook("playbooks/nope")
    expect(ok).toBe(false)
    expect(text).toContain('unknown cookbook "playbooks/nope"')
    for (const topic of PLAYBOOKS) expect(text).toContain(topic)
  })

  it("stays out of the always-resident prompt (L2 only)", () => {
    // §4: no new tools, no new commands, nothing added to the resident card.
    const card = buildSystemPrompt({ projectId: "p1", username: "alice", roleLevel: 700 })
    for (const topic of PLAYBOOKS) expect(card, topic).not.toContain(topic)
    expect(card).not.toContain("playbooks/")
  })
})

// AQU-1294 §2.3: the same skill bodies the Agent API serves (REST /skills,
// MCP get_skill) are docs topics here, so an in-app agent and an external one
// follow ONE playbook for partner project setup.
describe("agent skills as docs topics", () => {
  it("registers every shared skill under skills/<name>, serving the identical body", () => {
    expect(AGENT_SKILLS.length).toBeGreaterThan(0)
    for (const skill of AGENT_SKILLS) {
      const topic = `skills/${skill.name}`
      expect(COOKBOOK_TOPICS).toContain(topic)
      const { ok, text } = getCookbook(topic)
      expect(ok, topic).toBe(true)
      expect(text, topic).toBe(skill.body)
      expect(text.startsWith("# Skill:"), topic).toBe(true)
      expect(text, topic).toContain("THE HUMAN GATE")
      expect(text.toLowerCase(), topic).toMatch(/stage[sd]?\b[\s\S]*applie[sd]/i)
    }
  })

  it("project-setup names the four never-guess fields and refuses markup", () => {
    const text = getCookbook("skills/project-setup").text
    for (const f of ["sourceLanguage", "targetLanguage", "sourceTexts", "keyTerms"]) expect(text).toContain(f)
    expect(text).toContain("REFUSE")
    expect(text).toContain("parser problem")
  })

  it("stays out of the always-resident prompt (L2 only)", () => {
    const card = buildSystemPrompt({ projectId: "p1", username: "alice", roleLevel: 700 })
    expect(card).not.toContain("skills/")
  })
})
