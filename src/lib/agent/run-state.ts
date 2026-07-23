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

/**
 * One `run_code` sandbox call (AQU-AGENT §2/§4). `tool.code.start`/
 * `tool.code.output` carry no step counter (unlike code_start/code_result),
 * so `stdout`/`stderr`/`durationMs` are undefined until the matching output
 * frame arrives and reduceRunFrame pairs it with the most recently opened,
 * still-unpaired code item (see the reducer below).
 */
export interface CodeActivityItem {
  id: string
  kind: "code"
  language: string
  /** code_start's codePreview: first 400 chars. */
  codePreview: string
  stdout?: string
  stderr?: string
  truncated?: boolean
  durationMs?: number
}

/** A legacy persisted PlanImport changeset awaiting human approval. */
export interface ChangesetItem {
  id: string
  kind: "changeset"
  changesetId: string
  approvalUrl: string
  summary: string
  cellCount: number
}

/** A proposed project memory (agent_memories row), pending review. */
export interface MemoryProposedItem {
  id: string
  kind: "memory-proposed"
  memoryId: string
  path: string
  preview: string
  /** Flipped to "reviewed" via markMemoryReviewed once the Memory tab acts on
   *  it (mem-M5). Undefined is treated the same as "pending". */
  status?: "pending" | "reviewed"
}

/** A proposed project-brief update, pending review. */
export interface BriefProposedItem {
  id: string
  kind: "brief-proposed"
  proposalId: string
  preview: string
  /** Flipped to "reviewed" via markBriefReviewed once the Memory tab acts on
   *  it (mem-M5). Undefined is treated the same as "pending". */
  status?: "pending" | "reviewed"
}

export type TimelineItem =
  | TextItem
  | ToolItem
  | ProposalItem
  | AquiferProposalItem
  | CodeActivityItem
  | ChangesetItem
  | MemoryProposedItem
  | BriefProposedItem

export type AgentRunStatus = "running" | "ok" | "capped" | "error"

/** Cost-cap meter (AQU-AGENT §2 AGENT_RUN_COST_CAP_CENTS). Values are
 *  org-facing CREDITS (server applies agent-rail markup), never raw $. */
export interface AgentBudget {
  spentCredits: number
  capCredits: number
  /** Set once a `budget.exhausted` frame lands — the run halted at its cap. */
  exhausted: boolean
}

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
  usage?: { promptTokens: number; completionTokens: number; costCredits: number }
  /** Latest budget/budget.exhausted frame; undefined until the run reports one. */
  budget?: AgentBudget
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
    case "tool.code.start":
      return appendItem(run, {
        id: nextId(run),
        kind: "code",
        language: frame.language,
        codePreview: frame.codePreview,
      })
    case "tool.code.output": {
      // No step counter on these frames (contract §4) — pair with the most
      // recently opened code item that hasn't received output yet, scanning
      // from the end (same honest-contract posture as code_result above).
      for (let i = run.items.length - 1; i >= 0; i--) {
        const item = run.items[i]
        if (item.kind === "code" && item.durationMs === undefined) {
          const updated: CodeActivityItem = {
            ...item,
            stdout: frame.stdout,
            stderr: frame.stderr,
            truncated: frame.truncated,
            durationMs: frame.durationMs,
          }
          return { ...run, items: [...run.items.slice(0, i), updated, ...run.items.slice(i + 1)] }
        }
      }
      return run
    }
    case "changeset.staged":
      return appendItem(run, {
        id: nextId(run),
        kind: "changeset",
        changesetId: frame.changesetId,
        approvalUrl: frame.approvalUrl,
        summary: frame.summary,
        cellCount: frame.cellCount,
      })
    case "memory.proposed":
      return appendItem(run, {
        id: nextId(run),
        kind: "memory-proposed",
        memoryId: frame.memoryId,
        path: frame.path,
        preview: frame.preview,
        status: "pending",
      })
    case "brief.proposed":
      return appendItem(run, {
        id: nextId(run),
        kind: "brief-proposed",
        proposalId: frame.proposalId,
        preview: frame.preview,
        status: "pending",
      })
    case "budget":
      return { ...run, budget: { spentCredits: frame.spentCredits, capCredits: frame.capCredits, exhausted: false } }
    case "budget.exhausted":
      return { ...run, budget: { spentCredits: frame.spentCredits, capCredits: frame.capCredits, exhausted: true } }
    case "progress":
      return { ...run, progress: { label: frame.label, done: frame.done, total: frame.total } }
    case "usage":
      return {
        ...run,
        usage: {
          promptTokens: frame.promptTokens,
          completionTokens: frame.completionTokens,
          costCredits: frame.costCredits,
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

/** Flip a memory.proposed notice to "reviewed" after the Memory tab acts on
 * it (mem-M5) — a no-op if this run has no item for that memoryId. */
export function markMemoryReviewed(run: AgentRunUi, memoryId: string): AgentRunUi {
  return {
    ...run,
    items: run.items.map((item) =>
      item.kind === "memory-proposed" && item.memoryId === memoryId ? { ...item, status: "reviewed" } : item,
    ),
  }
}

/** Same as markMemoryReviewed, for brief.proposed notices. */
export function markBriefReviewed(run: AgentRunUi, proposalId: string): AgentRunUi {
  return {
    ...run,
    items: run.items.map((item) =>
      item.kind === "brief-proposed" && item.proposalId === proposalId ? { ...item, status: "reviewed" } : item,
    ),
  }
}
