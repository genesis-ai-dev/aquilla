// Shared fixtures for the contextual pipeline tests. Not a test file itself.

import type { CellPair } from "../agent/tools/select-cells"
import type { LlmCall, LlmRequest } from "./types"

export function pair(cellId: string, over: Partial<CellPair> = {}): CellPair {
  return {
    cellId,
    canonicalRef: null,
    sequenceIndex: null,
    anchorCellId: null,
    source: `source of ${cellId}`,
    target: "",
    validated: false,
    aiDrafted: false,
    sourceHead: null,
    targetBasedOn: null,
    hasTargetRow: false,
    ...over,
  }
}

export interface ScriptedLlm {
  llm: LlmCall
  calls: LlmRequest[]
}

/** A mock LlmCall returning canned replies in order (a function entry may
 *  compute its reply from the request). Throws when the script runs out. */
export function scriptedLlm(replies: (string | ((req: LlmRequest) => string))[]): ScriptedLlm {
  const calls: LlmRequest[] = []
  const queue = [...replies]
  const llm: LlmCall = async (req) => {
    calls.push(req)
    const next = queue.shift()
    if (next === undefined) throw new Error(`scripted LLM exhausted after ${calls.length} call(s)`)
    return typeof next === "function" ? next(req) : next
  }
  return { llm, calls }
}

export function construalJson(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    situation: "a teacher addresses a crowd",
    participants: ["teacher", "crowd"],
    tenor: "authoritative but familiar",
    moves: ["summon", "teach"],
    closed: false,
    openQuestions: [],
    evidenceCellIds: ["c1"],
    ...over,
  })
}

export function voteJson(
  approve: boolean,
  cells: { i: number; approve: boolean; reason?: string }[] = [],
  reason = approve ? "no failure found" : "failure found",
): string {
  return JSON.stringify({ approve, reason, cells })
}

export function draftJson(entries: { i: number; t: string }[]): string {
  return JSON.stringify(entries)
}
