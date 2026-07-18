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
 *
 * PERSISTENCE (AQU-415): the agent conversation survives a page reload. The
 * durable slice — server sessionId, the run timeline, per-row review decisions,
 * and queued card-activity notes — is written to localStorage (via the injected
 * `SessionPersistence`) whenever the session settles, and rehydrated when the
 * per-project store is first constructed. Transient stream state (isStreaming /
 * the in-memory send queue, which carries the JWT) is never persisted, and a
 * run caught mid-stream by the reload is normalized to a terminal state on load.
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

/**
 * The durable slice of a session, in JSON-serializable form (Map → entries).
 * Deliberately excludes `isStreaming`/`queued` — the queue holds JWTs and a
 * reload always ends any in-flight stream.
 */
export interface PersistedSession {
  sessionId: string
  runs: AgentRunUi[]
  decided: [string, RowDecision][]
  activity: { key: string; note: string }[]
}

/** Storage adapter for a session's durable slice. */
export interface SessionPersistence {
  load(): PersistedSession | null
  save(session: PersistedSession): void
}

/**
 * localStorage-backed persistence for one project's agent session. All access
 * is guarded — a disabled/quota-full/unavailable store degrades to ephemeral
 * behaviour rather than throwing (Tauri, private mode, SSR).
 */
export function localStoragePersistence(projectId: string): SessionPersistence {
  const key = `aquilla:agent-session:v1:${projectId}`
  return {
    load() {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw) as PersistedSession
        if (typeof parsed?.sessionId !== "string" || !Array.isArray(parsed.runs)) return null
        return {
          sessionId: parsed.sessionId,
          runs: parsed.runs,
          decided: Array.isArray(parsed.decided) ? parsed.decided : [],
          activity: Array.isArray(parsed.activity) ? parsed.activity : [],
        }
      } catch {
        return null
      }
    },
    save(session) {
      try {
        localStorage.setItem(key, JSON.stringify(session))
      } catch {
        /* quota exceeded or storage unavailable — stay ephemeral */
      }
    },
  }
}

/**
 * A run still `running` when the reload froze it can never resume (its server
 * stream is gone), so present it as an interrupted, terminal run rather than a
 * forever-spinner. Completed/errored runs pass through untouched.
 */
function hydrateRun(run: AgentRunUi): AgentRunUi {
  return run.status === "running" ? failRun(run, "Interrupted by a page reload.") : run
}

export class AgentSessionStore {
  private state: AgentSessionState
  private listeners = new Set<() => void>()
  private abortController: AbortController | null = null
  private queue: AgentSendOptions[] = []
  private readonly runAgent: RunAgentFn
  private readonly persistence?: SessionPersistence

  constructor(runAgentImpl: RunAgentFn = realRunAgent, persistence?: SessionPersistence) {
    this.runAgent = runAgentImpl
    this.persistence = persistence
    const restored = persistence?.load()
    this.state = restored
      ? {
          sessionId: restored.sessionId,
          runs: restored.runs.map(hydrateRun),
          isStreaming: false,
          queued: [],
          decided: new Map(restored.decided),
          activity: restored.activity,
        }
      : {
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
    // Persist only when the session is settled — skips the high-frequency
    // per-frame writes during a stream (they'd re-serialize the whole timeline
    // on every token); the terminal `isStreaming: false` set flushes the final
    // state. reset()'s fresh empty state is written the same way, clearing the
    // prior conversation.
    if (this.persistence && !this.state.isStreaming) {
      this.persistence.save({
        sessionId: this.state.sessionId,
        runs: this.state.runs,
        decided: [...this.state.decided],
        activity: [...this.state.activity],
      })
    }
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
    store = new AgentSessionStore(realRunAgent, localStoragePersistence(projectId))
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
