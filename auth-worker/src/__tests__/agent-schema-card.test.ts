// schema-card.ts — the SFL "situation bounds meaning" property (design §2):
// an event kind a role cannot emit must be ABSENT from that role's prompt,
// not merely rejected later. These tests pin the role-filtered event card
// and the mirror of sync-worker/src/events/role-policy.ts — if the source
// table changes, the mirror (and these pins) must change with it.

import { describe, it, expect } from "vitest"
import {
  buildSystemPrompt,
  allowedKindsForRole,
  AGENT_REQUIRED_ROLE,
  AGENT_ROLE,
} from "../lib/agent/schema-card"

const baseCtx = { projectId: "p1", username: "tester" }

describe("buildSystemPrompt — role filtering", () => {
  it("REVIEWER (300): contains cell.validate but NOT target.cell.commit", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.REVIEWER })
    expect(prompt).toContain("cell.validate")
    expect(prompt).not.toContain("target.cell.commit")
    expect(prompt).not.toContain("target.cell.create")
    // Commenting is below reviewer, so it stays available.
    expect(prompt).toContain("comment.create")
  })

  it("CONTRIBUTOR (400): contains target.cell.commit but no source.* or assignment.*", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.CONTRIBUTOR })
    expect(prompt).toContain("target.cell.commit")
    expect(prompt).not.toContain("source.cell.create")
    expect(prompt).not.toContain("source.cell.commit")
    expect(prompt).not.toContain("assignment.create")
    expect(prompt).not.toContain("file.delete")
  })

  it("VIEWER (100): read-only — no emit-able kinds, explicit do-not-emit line", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.VIEWER })
    expect(prompt).toContain("read-only")
    expect(prompt).not.toContain("comment.create {")
    expect(allowedKindsForRole(AGENT_ROLE.VIEWER)).toEqual([])
  })

  it("PROJECT_LEAD (500): assignments and source-side appear", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.PROJECT_LEAD })
    expect(prompt).toContain("assignment.create")
    expect(prompt).toContain("source.cell.commit")
  })

  it("documents the dynamic variables, including focus vars only when bound", () => {
    const unfocused = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(unfocused).toContain(":project")
    expect(unfocused).toContain(":user")
    expect(unfocused).not.toContain(":file = the focused")

    const focused = buildSystemPrompt({ ...baseCtx, roleLevel: 400, fileId: "f1", cellId: "c1" })
    expect(focused).toContain(":file = the focused")
    expect(focused).toContain(":cell = the focused")
  })

  it("stays within the L1 budget (≤250 lines of prompt text)", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: AGENT_ROLE.OWNER })
    expect(prompt.split("\n").length).toBeLessThanOrEqual(250)
  })

  it("stays within the L1 budget even with a worst-case multi-line brief summary", () => {
    // The injected brief block can carry up to L1_MAX_CHARS; a multi-paragraph
    // summary adds the most newlines. Pin that the card still fits the budget.
    const prompt = buildSystemPrompt({
      ...baseCtx,
      roleLevel: AGENT_ROLE.OWNER,
      briefSummary: "Line of brief guidance.\n".repeat(30),
    })
    expect(prompt.split("\n").length).toBeLessThanOrEqual(250)
  })

  // First real-model run (2026-06-12): the model treated #c aliases as the
  // user's segment numbers and could not order a sequence file. These pins
  // keep the card teaching what that run proved it must teach.
  it("declares aliases opaque and bans showing them to the user", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(prompt).toContain("OPAQUE")
    expect(prompt).toContain("NEVER show them to the user")
  })

  it("teaches ordering per file kind, including sequence_index for segments", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(prompt).toContain("sequence_index")
    expect(prompt).toContain('"segment 8"')
  })

  it("teaches the semantic tools and demotes sql to an escape hatch", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(prompt).toContain("read(")
    expect(prompt).toContain("draft(")
    expect(prompt).toContain("examples(")
    expect(prompt).toContain("ESCAPE HATCH")
    // The recipe steers drafting through the pipeline tool, not hand-writing.
    expect(prompt).toContain("Do NOT hand-write translations")
  })

  // Budget mirrors frequency: drafting is the 80% case, so its canonical
  // recipe lives in L1 — both 2026-06-12 real-model runs meandered through
  // exploratory SQL instead of fetching the L2 cookbook.
  it("inlines the canonical drafting recipe for commit-capable roles only", () => {
    const contributor = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(contributor).toContain("Canonical drafting recipe")
    expect(contributor).toContain("information_schema is queryable WITHOUT :project")

    // A reviewer cannot commit, so the recipe (which names the event kind)
    // must be absent — same property as the event-card filtering.
    const reviewer = buildSystemPrompt({ ...baseCtx, roleLevel: 300 })
    expect(reviewer).not.toContain("Canonical drafting recipe")
  })

  // Second real-model run (2026-06-12): the model found the right verse but
  // stalled to ask "what language?" and "this one or the first one?" — both
  // derivable. These pins keep the prompt answering them pre-emptively.
  it("states the language pair and bans asking for it; absent pair → infer, don't stall", () => {
    const withPair = buildSystemPrompt({
      ...baseCtx,
      roleLevel: 400,
      sourceLanguage: "English",
      targetLanguage: "Punjabi",
    })
    expect(withPair).toContain("from English into Punjabi")
    expect(withPair).toContain("language for translation output, not ordinary conversation")
    expect(withPair).toContain("Never ask the user what language")

    const withoutPair = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(withoutPair).toContain("infer it from the project's existing target text")
    expect(withoutPair).toContain("do not stall the run to ask")
  })

  it("anchors 'next'/'previous' to the focused cell when one is pinned", () => {
    const withCell = buildSystemPrompt({ ...baseCtx, roleLevel: 400, fileId: "f1", cellId: "c1" })
    expect(withCell).toContain("relative to the focused cell :cell")

    const withoutCell = buildSystemPrompt({ ...baseCtx, roleLevel: 400, fileId: "f1" })
    expect(withoutCell).not.toContain("relative to the focused cell")
  })

  it("tells the model to act-then-approve instead of asking permission", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(prompt).toContain("staging IS the confirmation mechanism")
    expect(prompt).toContain("at most ONE question")
  })

  it("injects the translator profile as JSON and treats its language as a fallback", () => {
    const prompt = buildSystemPrompt({
      ...baseCtx,
      roleLevel: 400,
      translatorProfile: { age: "32", religiousBackground: "Christian", responseLanguage: "Tagalog" },
      responseLanguage: "Tagalog",
    })
    expect(prompt).toContain("## Translator profile")
    expect(prompt).toContain('"age": "32"')
    expect(prompt).toContain('"religiousBackground": "Christian"')
    expect(prompt).toContain("Use Tagalog only as the fallback conversation language")
    expect(prompt).toContain("reply in the language the user just used")
    expect(prompt).not.toContain("Respond to the user in Tagalog")
  })

  it("caps over-long profile fields and drops empty ones (never trust the client)", () => {
    const prompt = buildSystemPrompt({
      ...baseCtx,
      roleLevel: 400,
      translatorProfile: { otherInfo: "z".repeat(500), gender: "   " },
    })
    // 280-char cap (PROFILE_FIELD_MAX) — the 281st z must not appear.
    expect(prompt).toContain("z".repeat(280))
    expect(prompt).not.toContain("z".repeat(281))
    expect(prompt).not.toContain('"gender"')
  })

  it("adds no profile block when none is supplied", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(prompt).not.toContain("## Translator profile")
    expect(prompt).not.toContain("fallback conversation language")
  })

  it("grounds the situation when a file is focused — name, kind, and relative-reference rule", () => {
    const unfocused = buildSystemPrompt({ ...baseCtx, roleLevel: 400 })
    expect(unfocused).not.toContain("## Current situation")

    const focused = buildSystemPrompt({
      ...baseCtx,
      roleLevel: 400,
      fileId: "f1",
      fileName: "Ruth",
      fileKind: "sequence",
    })
    expect(focused).toContain("## Current situation")
    expect(focused).toContain('"Ruth"')
    expect(focused).toContain("kind: sequence")
    expect(focused).toContain("refer to THIS file")
  })
})

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

describe("AGENT_REQUIRED_ROLE — mirror of sync-worker role-policy.ts", () => {
  it("pins the floors the agent's safety depends on", () => {
    expect(AGENT_REQUIRED_ROLE["target.cell.commit"]).toBe(400)
    expect(AGENT_REQUIRED_ROLE["cell.validate"]).toBe(300)
    expect(AGENT_REQUIRED_ROLE["comment.create"]).toBe(200)
    expect(AGENT_REQUIRED_ROLE["source.cell.commit"]).toBe(500)
    expect(AGENT_REQUIRED_ROLE["assignment.create"]).toBe(500)
    expect(AGENT_REQUIRED_ROLE["file.delete"]).toBe(500)
  })

  it("covers all 28 event kinds from sync-worker/src/events/types.ts", () => {
    expect(Object.keys(AGENT_REQUIRED_ROLE)).toHaveLength(28)
  })
})
