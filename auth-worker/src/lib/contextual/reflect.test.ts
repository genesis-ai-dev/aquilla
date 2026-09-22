// Park-time reflection, pure half (AQU-1302). WHY these: everything here
// stands between a model's free-text reply and a row a human is asked to
// review. The bounds (at most three notes, nothing unreadable, nothing
// duplicated) are the difference between a durable note and a review chore, so
// each one is pinned against the shapes a model actually produces — fenced
// JSON, a bare array, a prose preamble, a half-filled entry.

import { describe, it, expect } from "vitest"
import {
  MAX_REFLECTION_PROPOSALS,
  MIN_SPANS_SINCE_REFLECTION,
  parseReflectionNotes,
  reflectOnRun,
  reflectionPathFromTitle,
  reflectionUserPrompt,
  shouldReflect,
  type ReflectionEvidence,
  type ReflectionKnown,
} from "./reflect"
import { validateMemoryPath } from "../../../../db/shared/agent-memory"
import type { ContextualRun } from "../../../../db/shared/contextual-runs"
import type { LlmRequest } from "./types"

function reply(notes: { title: string; note: string; why?: string }[]): string {
  return JSON.stringify({ notes })
}

const evidence: ReflectionEvidence = {
  drafts: [{ label: "MRK 1:1", text: "In the beginning" }],
  directions: ["keep the register plain"],
  answeredDecisions: [{ question: "Formal or informal you?", answer: "informal" }],
}

const known: ReflectionKnown = {
  targetLanguage: "es",
  memories: [{ path: "autopilot/register.md", content: "Plain register." }],
  rules: ["No exclamation marks"],
  terms: ["covenant → pacto (preferred)"],
}

function runAt(doneSpans: number, reflectedDoneSpans: number): ContextualRun {
  return {
    id: "run-1",
    projectId: "p",
    fileId: "f",
    targetLang: "",
    status: "parked",
    initiatedBy: "tester",
    roleSnapshot: null,
    spanCursor: null,
    doneSpans,
    totalSpans: doneSpans,
    failedSpans: 0,
    unitsSpent: 0,
    callsSpent: 0,
    lastError: null,
    steeringCursor: null,
    blockedOnDecisionId: null,
    // AQU-1300 trust gate: unlimited allowance, parked because the scope ran out.
    spanAllowance: null,
    parkReason: "work_exhausted",
    anchorCellId: null,
    scopeGroup: null,
    reflectedAt: null,
    reflectedDoneSpans,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  }
}

describe("shouldReflect", () => {
  it("needs at least two passages of NEW work", () => {
    expect(shouldReflect(runAt(1, 0))).toBe(false)
    expect(shouldReflect(runAt(MIN_SPANS_SINCE_REFLECTION, 0))).toBe(true)
  })

  it("counts from the last reflection, not from the start of the run", () => {
    // A long run that already reflected at 10 must not reflect again on the
    // strength of that same history — only on what happened since.
    expect(shouldReflect(runAt(11, 10))).toBe(false)
    expect(shouldReflect(runAt(12, 10))).toBe(true)
  })
})

describe("reflectionPathFromTitle", () => {
  it("derives a path the memory store accepts", () => {
    const path = reflectionPathFromTitle("Register: keep it Plain!", 0)
    expect(path).toBe("autopilot/register-keep-it-plain.md")
    expect(validateMemoryPath(path)).toBeNull()
  })

  it("falls back to an indexed name when a title slugifies to nothing", () => {
    // A title written entirely in the target script is normal, not an error.
    const path = reflectionPathFromTitle("မှတ်စု", 2)
    expect(path).toBe("autopilot/note-3.md")
    expect(validateMemoryPath(path)).toBeNull()
  })
})

describe("parseReflectionNotes", () => {
  it("reads the documented shape and keeps the reason", () => {
    const notes = parseReflectionNotes(
      reply([{ title: "Plain register", note: "Keep it plain.", why: "the reviewer kept fixing it" }]),
    )
    expect(notes).toEqual([
      {
        path: "autopilot/plain-register.md",
        content: "# Plain register\n\nKeep it plain.",
        rationale: "the reviewer kept fixing it",
      },
    ])
  })

  it("reads a fenced reply and a bare array too", () => {
    const fenced = "```json\n" + reply([{ title: "A", note: "B" }]) + "\n```"
    expect(parseReflectionNotes(fenced)).toHaveLength(1)
    expect(parseReflectionNotes(JSON.stringify([{ title: "A", note: "B" }]))).toHaveLength(1)
  })

  it("finds the JSON inside a preamble the prompt asked it not to write", () => {
    const padded = `Here are my notes:\n${reply([{ title: "A", note: "B" }])}\nHope that helps.`
    expect(parseReflectionNotes(padded)).toHaveLength(1)
  })

  it("enforces the cap of three", () => {
    const notes = parseReflectionNotes(
      reply([
        { title: "One", note: "1" },
        { title: "Two", note: "2" },
        { title: "Three", note: "3" },
        { title: "Four", note: "4" },
      ]),
    )
    expect(notes).toHaveLength(MAX_REFLECTION_PROPOSALS)
    expect(notes.map((note) => note.path)).not.toContain("autopilot/four.md")
  })

  it("drops an entry with no title or no guidance rather than proposing a blank", () => {
    const notes = parseReflectionNotes(
      reply([
        { title: "", note: "orphaned guidance" },
        { title: "No guidance", note: "" },
        { title: "Good", note: "keep this" },
      ]),
    )
    expect(notes.map((note) => note.path)).toEqual(["autopilot/good.md"])
  })

  it("collapses two notes that would land on the same path", () => {
    const notes = parseReflectionNotes(
      reply([
        { title: "Plain register", note: "first" },
        { title: "plain register!", note: "second" },
      ]),
    )
    expect(notes).toHaveLength(1)
    expect(notes[0].content).toContain("first")
  })

  it("returns nothing for an unparseable or empty reply", () => {
    expect(parseReflectionNotes("the model apologises")).toEqual([])
    expect(parseReflectionNotes("")).toEqual([])
    expect(parseReflectionNotes(reply([]))).toEqual([])
  })

  it("supplies a rationale when the model omits one", () => {
    const [note] = parseReflectionNotes(reply([{ title: "A", note: "B" }]))
    expect(note.rationale).not.toBe("")
  })
})

describe("reflectionUserPrompt", () => {
  it("shows the model what is already known, so it can skip it", () => {
    const prompt = reflectionUserPrompt(evidence, known)
    expect(prompt).toContain("autopilot/register.md")
    expect(prompt).toContain("No exclamation marks")
    expect(prompt).toContain("covenant → pacto (preferred)")
    expect(prompt).toContain("keep the register plain")
    expect(prompt).toContain("Formal or informal you?")
  })

  it("renders empty evidence sections as (none) rather than dropping them", () => {
    const prompt = reflectionUserPrompt(
      { drafts: [], directions: [], answeredDecisions: [] },
      { memories: [], rules: [], terms: [] },
    )
    expect(prompt).toContain("(none)")
  })
})

describe("reflectOnRun", () => {
  it("spends exactly one model call", async () => {
    const calls: LlmRequest[] = []
    const notes = await reflectOnRun({
      llm: async (req) => {
        calls.push(req)
        return reply([{ title: "Plain register", note: "Keep it plain." }])
      },
      evidence,
      known,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain("[[ctx:reflect]]")
    expect(notes).toHaveLength(1)
  })

  it("propagates a model failure to the caller, which owns the swallow", async () => {
    // reflectAtPark/the tick decide what a failure means for the park. This
    // layer must not quietly turn one into "nothing to say".
    await expect(
      reflectOnRun({
        llm: async () => {
          throw new Error("provider down")
        },
        evidence,
        known,
      }),
    ).rejects.toThrow("provider down")
  })
})
