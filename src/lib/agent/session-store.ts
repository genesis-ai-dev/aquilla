/**
 * session-store.ts — per-project agent session state, shared across mounts.
 *
 * The dock panel and the full-screen workbench render the SAME conversation:
 * state lives here (module scope, keyed by project id), not in either
 * component, so switching mounts mid-run loses nothing and an in-flight run
 * keeps streaming when the dock unmounts. Each store owns one server session
 * (client-generated UUID sent as AgentRunRequest.sessionId — the server holds
 * the full conversation including tool results under it).
 *
 * Prompts sent while a run is streaming are QUEUED and dispatched in order
 * when the current run settles (agentic-CLI steering, not a locked composer).
 */

import { useCallback, useSyncExternalStore } from "react"
import { runAgent as realRunAgent } from "./agent-client"
import type { AgentRunRequest } from "./protocol"
import { createRun, failRun, reduceRunFrame, type AgentRunUi } from "./run-state"
import type { RowDecision } from "./working-set"

export interface AgentSendOptions {
  /** What the model receives (prompt + chip legend). */
  wire: string
  /** What the user bubble shows (prompt with [ref] chips). */
  display: string
  /** Frontier session JWT. */
  jwt: string
  /** Everything but sessionId/messages — projectId, context, profile. */
  request: Omit<AgentRunRequest, "sessionId" | "messages">
}

export interface AgentSessionState {
  sessionId: string
  runs: AgentRunUi[]
  isStreaming: boolean
  /** Prompts waiting for the current run to settle (display text, for UI). */
  queued: string[]
  /**
   * Per-proposal-row review decisions (key: proposalRowKey). Lives here, not
   * in the workbench, so closing/reopening the workbench cannot forget what
   * was already applied — forgetting would re-offer applied drafts as
   * pending (double-apply) and lose the Undo affordance.
   */
  decided: ReadonlyMap<string, RowDecision>
  /**
   * Card-interaction notes queued for the model (agent-complete design §5):
   * e.g. "the user navigated the MRK 4 passage view to MRK 5". Drained into
   * the next send's WIRE message only — the visible bubble stays what the
   * user typed. Coalesced by key so only the latest note per card survives.
   */
  activity: ReadonlyArray<{ key: string; note: string }>
}

type RunAgentFn = typeof realRunAgent

export class AgentSessionStore {
  private state: AgentSessionState
  private listeners = new Set<() => void>()
  private abortController: AbortController | null = null
  private queue: AgentSendOptions[] = []
  private readonly runAgent: RunAgentFn

  constructor(runAgentImpl: RunAgentFn = realRunAgent) {
    this.runAgent = runAgentImpl
    this.state = {
      sessionId: crypto.randomUUID(),
      runs: [],
      isStreaming: false,
      queued: [],
      decided: new Map(),
      activity: [],
    }
  }

  getState = (): AgentSessionState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(partial: Partial<AgentSessionState>): void {
    this.state = { ...this.state, ...partial }
    for (const l of this.listeners) l()
  }

  private updateRun(localId: string, next: (run: AgentRunUi) => AgentRunUi): void {
    this.set({ runs: this.state.runs.map((r) => (r.localId === localId ? next(r) : r)) })
  }

  /** Send now, or queue if a run is streaming. Returns immediately. */
  send = (options: AgentSendOptions): void => {
    if (this.state.isStreaming) {
      this.queue.push(options)
      this.set({ queued: this.queue.map((q) => q.display) })
      return
    }
    void this.dispatch(options)
  }

  /** Abort the in-flight run AND drop anything queued behind it. */
  stop = (): void => {
    this.queue = []
    this.set({ queued: [] })
    this.abortController?.abort()
  }

  /** Drop the conversation and start a fresh server session. */
  reset = (): void => {
    this.stop()
    this.set({ sessionId: crypto.randomUUID(), runs: [], isStreaming: false, queued: [], decided: new Map(), activity: [] })
  }

  /**
   * Queue a card-interaction note for the model's next turn. Same `key`
   * replaces (a card's latest navigation supersedes its earlier ones);
   * distinct keys accumulate in interaction order.
   */
  noteActivity = (key: string, note: string): void => {
    const kept = this.state.activity.filter((a) => a.key !== key)
    this.set({ activity: [...kept, { key, note }] })
  }

  /** Record review decisions (accept/edit/reject/undo) for proposal rows. */
  decide = (entries: Iterable<[string, RowDecision]>): void => {
    const next = new Map(this.state.decided)
    for (const [key, decision] of entries) next.set(key, decision)
    this.set({ decided: next })
  }

  private async dispatch(options: AgentSendOptions): Promise<void> {
    // Drain queued card-interaction notes into the WIRE message only — the
    // bubble (display) stays what the user typed. Drained here (not in send)
    // so notes queued while a run streams ride the next dispatched turn.
    const activity = this.state.activity
    const wire =
      activity.length === 0
        ? options.wire
        : `${options.wire}\n\n[user activity since your last reply]\n${activity
            .map((a) => `- ${a.note}`)
            .join("\n")}`
    if (activity.length > 0) this.set({ activity: [] })

    const run = createRun(options.display, wire)
    const controller = new AbortController()
    this.abortController = controller
    this.set({ runs: [...this.state.runs, run], isStreaming: true })

    try {
      await this.runAgent({
        request: {
          ...options.request,
          sessionId: this.state.sessionId,
          // Session-native: the server holds prior turns (incl. tool results);
          // the wire carries ONLY the new user message.
          messages: [{ role: "user", content: wire }],
        },
        jwt: options.jwt,
        signal: controller.signal,
        onFrame: (frame) => this.updateRun(run.localId, (r) => reduceRunFrame(r, frame)),
      })
      // Stream closed without a done frame → don't leave a forever-spinner.
      this.updateRun(run.localId, (r) => (r.status === "running" ? { ...r, status: "ok" } : r))
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        this.updateRun(run.localId, (r) => (r.status === "running" ? failRun(r, "Stopped.") : r))
      } else {
        this.updateRun(run.localId, (r) => failRun(r, err instanceof Error ? err.message : String(err)))
      }
    } finally {
      if (this.abortController === controller) this.abortController = null
      const next = this.queue.shift()
      this.set({ isStreaming: false, queued: this.queue.map((q) => q.display) })
      if (next) void this.dispatch(next)
    }
  }
}

const stores = new Map<string, AgentSessionStore>()

export function agentSessionStore(projectId: string): AgentSessionStore {
  let store = stores.get(projectId)
  if (!store) {
    store = new AgentSessionStore()
    stores.set(projectId, store)
  }
  return store
}

/** Subscribe a component to the project's shared agent session. */
export function useAgentSession(projectId: string): {
  state: AgentSessionState
  send: (options: AgentSendOptions) => void
  stop: () => void
  reset: () => void
  decide: (entries: Iterable<[string, RowDecision]>) => void
  noteActivity: (key: string, note: string) => void
} {
  const store = agentSessionStore(projectId)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const send = useCallback((options: AgentSendOptions) => store.send(options), [store])
  const stop = useCallback(() => store.stop(), [store])
  const reset = useCallback(() => store.reset(), [store])
  const decide = useCallback(
    (entries: Iterable<[string, RowDecision]>) => store.decide(entries),
    [store],
  )
  const noteActivity = useCallback(
    (key: string, note: string) => store.noteActivity(key, note),
    [store],
  )
  return { state, send, stop, reset, decide, noteActivity }
}
