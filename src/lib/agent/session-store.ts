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
    this.set({ sessionId: crypto.randomUUID(), runs: [], isStreaming: false, queued: [] })
  }

  private async dispatch(options: AgentSendOptions): Promise<void> {
    const run = createRun(options.display, options.wire)
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
          messages: [{ role: "user", content: options.wire }],
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
} {
  const store = agentSessionStore(projectId)
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const send = useCallback((options: AgentSendOptions) => store.send(options), [store])
  const stop = useCallback(() => store.stop(), [store])
  const reset = useCallback(() => store.reset(), [store])
  return { state, send, stop, reset }
}
