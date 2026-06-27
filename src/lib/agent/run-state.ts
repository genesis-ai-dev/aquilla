/**
 * run-state.ts — pure UI-state reducer for one agent run.
 *
 * AgentDockView feeds every parsed AgentFrame through `reduceRunFrame`;
 * AgentRunView/ProposalCard render the resulting AgentRunUi. Pure so the
 * frame → state mapping is unit-testable without streaming or React.
 */

import type { AgentFrame, AgentProposal, AquiferPublishProposal } from "./protocol"

export interface AgentStepUi {
  step: number
  kind: "sql" | "emit" | "docs" | "aquifer"
  /** code_start summary: first 120 chars of sql / "N events" / docs topic. */
  summary: string
  /** Undefined until the matching code_result frame arrives. */
  ok?: boolean
  /** Compressed result block (what the model saw), ≤2000 chars. */
  resultSummary?: string
}

export type AgentRunStatus = "running" | "ok" | "capped" | "error"

export interface AgentRunUi {
  /** Local list key — assigned by the dock, not the server. */
  localId: string
  /** The user prompt that started this run (display text, with [ref] chips). */
  prompt: string
  /** The exact content sent to the model for this turn (prompt + chip legend).
   *  Defaults to `prompt` when no chips were attached. */
  wireContent?: string
  /** Server run id (run_start frame); null until it arrives. */
  runId: string | null
  assistantText: string
  steps: AgentStepUi[]
  proposals: AgentProposal[]
  /** Bible Aquifer publish proposals (aquifer_proposal frames). Optional so
   *  pre-existing AgentRunUi fixtures (which predate this field) still type. */
  aquiferProposals?: AquiferPublishProposal[]
  usage?: { promptTokens: number; completionTokens: number; costCents: number }
  status: AgentRunStatus
  errorMessage?: string
}

let runCounter = 0

export function createRun(prompt: string, wireContent?: string): AgentRunUi {
  return {
    localId: `run-${Date.now().toString(36)}-${++runCounter}`,
    prompt,
    wireContent: wireContent ?? prompt,
    runId: null,
    assistantText: "",
    steps: [],
    proposals: [],
    aquiferProposals: [],
    status: "running",
  }
}

export function reduceRunFrame(run: AgentRunUi, frame: AgentFrame): AgentRunUi {
  switch (frame.type) {
    case "run_start":
      return { ...run, runId: frame.runId }
    case "assistant_delta":
      return { ...run, assistantText: run.assistantText + frame.text }
    case "code_start":
      return {
        ...run,
        steps: [...run.steps, { step: frame.step, kind: frame.kind, summary: frame.summary }],
      }
    case "code_result":
      return {
        ...run,
        steps: run.steps.map((s) =>
          s.step === frame.step ? { ...s, ok: frame.ok, resultSummary: frame.summary } : s,
        ),
      }
    case "proposal":
      return { ...run, proposals: [...run.proposals, frame.proposal] }
    case "aquifer_proposal":
      return { ...run, aquiferProposals: [...(run.aquiferProposals ?? []), frame.proposal] }
    case "usage":
      return {
        ...run,
        usage: {
          promptTokens: frame.promptTokens,
          completionTokens: frame.completionTokens,
          costCents: frame.costCents,
        },
      }
    case "done":
      // A prior error frame wins — done {status:'ok'} can't un-fail a run.
      return {
        ...run,
        runId: frame.runId,
        status: run.status === "error" ? "error" : frame.status,
      }
    case "error":
      // An error frame may be followed by done {status:'error'} — either
      // order leaves status 'error' with the message retained.
      return { ...run, status: "error", errorMessage: frame.message }
  }
}

/** Mark a run failed for non-frame failures (network drop, abort, non-2xx). */
export function failRun(run: AgentRunUi, message: string): AgentRunUi {
  if (run.status === "error") return run
  return { ...run, status: "error", errorMessage: message }
}
