/**
 * run-state.ts — pure UI-state reducer for one agent run.
 *
 * The run is an ORDERED TIMELINE: frames arrive on the wire in true execution
 * order (prose deltas interleaved with code_start/code_result and proposals),
 * and the reducer preserves that order as `items[]` instead of folding text
 * into one blob and steps into a side list. AgentRunView renders items in
 * order, so a tool chip appears exactly where the model called it.
 *
 * Pure so the frame → state mapping is unit-testable without streaming or
 * React.
 */

import type {
  AgentFrame,
  AgentProposal,
  AquiferPublishProposal,
  ExamplePair,
  PassageRow,
  SearchHit,
  ToolKind,
  ToolResultData,
} from "./protocol"

export type { ExamplePair, PassageRow, SearchHit, ToolKind, ToolResultData }

export interface TextItem {
  id: string
  kind: "text"
  /** Markdown, grown by assistant_delta frames. */
  text: string
}

export interface ToolItem {
  id: string
  kind: "tool"
  /** Server step counter — code_result frames attach by this. */
  step: number
  tool: ToolKind
  /** code_start summary: first 120 chars of sql / "N events" / docs topic. */
  summary: string
  /** Undefined until the matching code_result frame arrives. */
  ok?: boolean
  /** Compressed result block (what the model saw), ≤2000 chars. */
  resultSummary?: string
  /** Typed result payload for rich rendering (working-set rows etc.). */
  data?: ToolResultData
}

export interface ProposalItem {
  id: string
  kind: "proposal"
  proposal: AgentProposal
}

export interface AquiferProposalItem {
  id: string
  kind: "aquifer"
  proposal: AquiferPublishProposal
}

export type TimelineItem = TextItem | ToolItem | ProposalItem | AquiferProposalItem

export type AgentRunStatus = "running" | "ok" | "capped" | "error"

export interface AgentProgress {
  label: string
  done: number
  total: number
}

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
  /** Ordered timeline: prose, tool chips, and proposals in arrival order. */
  items: TimelineItem[]
  /** Live bulk-job progress (progress frames); cleared when the run settles. */
  progress?: AgentProgress
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
    items: [],
    status: "running",
  }
}

/** All prose the model produced, in order — the prior-turn assistant content. */
export function assistantTextOf(run: AgentRunUi): string {
  return run.items
    .filter((i): i is TextItem => i.kind === "text")
    .map((i) => i.text)
    .join("\n\n")
    .trim()
}

/** Every staged event-proposal in the run, in stage order. */
export function proposalsOf(run: AgentRunUi): AgentProposal[] {
  return run.items.filter((i): i is ProposalItem => i.kind === "proposal").map((i) => i.proposal)
}

const nextId = (run: AgentRunUi): string => `i${run.items.length}`

function appendItem(run: AgentRunUi, item: TimelineItem): AgentRunUi {
  return { ...run, items: [...run.items, item] }
}

export function reduceRunFrame(run: AgentRunUi, frame: AgentFrame): AgentRunUi {
  switch (frame.type) {
    case "run_start":
      return { ...run, runId: frame.runId }
    case "assistant_delta": {
      const last = run.items[run.items.length - 1]
      if (last?.kind === "text") {
        const grown: TextItem = { ...last, text: last.text + frame.text }
        return { ...run, items: [...run.items.slice(0, -1), grown] }
      }
      return appendItem(run, { id: nextId(run), kind: "text", text: frame.text })
    }
    case "code_start":
      return appendItem(run, {
        id: nextId(run),
        kind: "tool",
        step: frame.step,
        tool: frame.kind,
        summary: frame.summary,
      })
    case "code_result": {
      // Attach to the LAST tool item with this step (steps are unique per run,
      // but scanning from the end is the honest contract).
      for (let i = run.items.length - 1; i >= 0; i--) {
        const item = run.items[i]
        if (item.kind === "tool" && item.step === frame.step) {
          const updated: ToolItem = {
            ...item,
            ok: frame.ok,
            resultSummary: frame.summary,
            ...(frame.data ? { data: frame.data } : {}),
          }
          return { ...run, items: [...run.items.slice(0, i), updated, ...run.items.slice(i + 1)] }
        }
      }
      return run
    }
    case "proposal":
      return appendItem(run, { id: nextId(run), kind: "proposal", proposal: frame.proposal })
    case "aquifer_proposal":
      return appendItem(run, { id: nextId(run), kind: "aquifer", proposal: frame.proposal })
    case "progress":
      return { ...run, progress: { label: frame.label, done: frame.done, total: frame.total } }
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
        progress: undefined,
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
  return { ...run, status: "error", errorMessage: message, progress: undefined }
}
