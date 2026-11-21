// The offline-sync gate's scenario table. One row is one scripted fault story;
// `offline-gate.test.ts` runs every row through the same interpreter and the
// same invariants. To add a case, add a row and regenerate the golden
// (UPDATE_OFFLINE_GATE=1) in a PR of its own so the golden diff is the review.

import type { OutboxEventKind } from "../outbox-types"
import type { EventsFault, TokenFault } from "./harness"

export interface EventSpec {
  /** Default "c1". `null` for an event with no cell. */
  cell?: string | null
  /** Default "F1". `null` for an event with no fileId on its envelope. */
  file?: string | null
  /** Default "P1". */
  project?: string
  /** Default "target.cell.commit". */
  kind?: OutboxEventKind
  /** Chain parent. Default: the previous chain-mutating event declared for
   *  the same cell, so a scenario's events form the chain a user's edits do. */
  parent?: string
  payload?: Record<string, unknown>
}

export type Step =
  /** A new page over the same IndexedDB / localStorage / Web Locks. */
  | { do: "open"; tab: string }
  /** `each`: one enqueueOutboxEvent per event, awaited in order (default).
   *  `batch`: one enqueueOutboxEvents call. `unawaited`: every call made at
   *  once, none awaited (a page that is about to die). */
  | { do: "enqueue"; events: readonly string[]; tab?: string; as?: "each" | "batch" | "unawaited" }
  /** navigator.onLine, fetch and the socket follow; the window event fires. */
  | { do: "net"; online: boolean }
  /** Replace the scripted server answers still queued. */
  | { do: "faults"; events?: readonly EventsFault[]; token?: readonly TokenFault[] }
  /** The server forgets every sync token it issued. */
  | { do: "revokeTokens" }
  /** The session JWT stops being accepted by /sync-token. */
  | { do: "expireSession" }
  /** Sign in again: a new JWT (and a new authEpoch for a mounted flusher). */
  | { do: "reauth"; jwt: string; tab?: string }
  /** Parked requests go on. */
  | { do: "release" }
  /** HTTP drain: `times` passes of drainCycle(flushOutboxBatch), one after
   *  another; `together` starts that many at the same instant instead. */
  | { do: "cycle"; tab?: string; times?: number; together?: number }
  /** flushNow's half of an explicit retry, for the direct HTTP drain. */
  | { do: "releaseHolds"; tab?: string }
  | { do: "mount"; tab?: string }
  | { do: "unmount"; tab?: string }
  /** Fake time moves, in slices, the system settling after each. */
  | { do: "advance"; ms: number }
  /** The wall clock jumps; no timer fires. */
  | { do: "clock"; ms: number }
  /** The page dies: its locks are freed, nothing it started ever finishes. */
  | { do: "crash"; tab: string }
  /** `hold`: indexedDB.open stops completing. `pass`: new opens complete,
   *  held ones stay held. `proceed`: held ones complete. */
  | { do: "idb"; opens: "hold" | "pass" | "proceed" }
  | { do: "ws"; action: "connect" | "pump" | "drop"; tab?: string }
  | { do: "wsServer"; up?: boolean; lossy?: { deliver: number; ack: number } }

export interface Scenario {
  name: string
  drain: "http" | "hook" | "ws"
  events: Record<string, EventSpec>
  steps: readonly Step[]
  /** Events this scenario is KNOWN to lose, each with why. A loss that is not
   *  listed fails the gate; so does a listed event that is no longer lost. */
  knownLoss?: Record<string, string>
}

const ROLE_DOWNGRADED = "role downgraded since token was issued"
const ELEVATION_BODY = JSON.stringify({ error: "elevation required: verify to edit this project" })

/** Three edits: two chained on one cell, one on another. */
const THREE: Record<string, EventSpec> = { E1: {}, E2: {}, E3: { cell: "c2" } }

const HELD_FOR_STEP_UP: Pick<Scenario, "events" | "steps"> = {
  events: { E1: { project: "P2", file: "F9" }, E2: {} },
  steps: [
    { do: "faults", token: [{ status: 403, body: ELEVATION_BODY, project: "P2", times: "always" }] },
    { do: "enqueue", events: ["E1", "E2"] },
    { do: "cycle" },
  ],
}

export const SCENARIOS: readonly Scenario[] = [
  // ── HTTP drain: drainCycle over flushOutboxBatch, real token minter ─────
  {
    name: "offline for the whole enqueue, then online",
    drain: "http",
    events: THREE,
    steps: [
      { do: "net", online: false },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle" },
      { do: "net", online: true },
      { do: "cycle" },
    ],
  },
  {
    name: "5xx on the first two attempts, then success",
    drain: "http",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "http", status: 500, times: 2 }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle", times: 3 },
    ],
  },
  {
    name: "5xx on every attempt: nothing leaves the outbox",
    drain: "http",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "http", status: 503, times: "always" }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle", times: 7 },
    ],
  },
  {
    name: "network error after the server committed the whole batch, then retry",
    drain: "http",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "drop", commit: "all", error: "network" }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle", times: 2 },
    ],
  },
  {
    name: "timeout mid-batch with the first two of four committed, then retry",
    drain: "http",
    events: { E1: {}, E2: {}, E3: { cell: "c2" }, E4: { cell: "c2" } },
    steps: [
      { do: "faults", events: [{ type: "drop", commit: 2, error: "timeout" }] },
      { do: "enqueue", events: ["E1", "E2", "E3", "E4"] },
      { do: "cycle", times: 2 },
    ],
  },
  {
    name: "200 with an unreadable body after the server committed, then retry",
    drain: "http",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "malformed", commit: true }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle", times: 2 },
    ],
  },
  {
    name: "200 that neither accepts nor rejects one event, then retry",
    drain: "http",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "silent", ids: ["E2"] }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle", times: 2 },
    ],
  },
  {
    name: "sync token rejected by the server (401) until its client-side expiry passes",
    drain: "http",
    events: THREE,
    steps: [
      { do: "enqueue", events: ["E1"] },
      { do: "cycle" },
      { do: "revokeTokens" },
      { do: "enqueue", events: ["E2", "E3"] },
      { do: "cycle", times: 2 },
      { do: "clock", ms: 15 * 60_000 },
      { do: "cycle" },
    ],
  },
  {
    name: "session expired at /sync-token (401), then signed in again",
    drain: "http",
    events: THREE,
    steps: [
      { do: "expireSession" },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle", times: 2 },
      { do: "reauth", jwt: "jwt-2" },
      { do: "cycle" },
    ],
  },
  {
    name: "401 for one event inside a 200, five times over",
    drain: "http",
    events: { E1: {}, E2: { cell: "c2" } },
    steps: [
      { do: "faults", events: [{ type: "reject", status: 401, reason: "token expired", ids: ["E1"], times: "always" }] },
      { do: "enqueue", events: ["E1", "E2"] },
      { do: "cycle", times: 5 },
    ],
  },
  {
    name: "whole-request 403: the file's batch is quarantined, the next file drains",
    drain: "http",
    events: { E1: {}, E2: {}, E3: { file: "F2", cell: "c9" } },
    steps: [
      { do: "faults", events: [{ type: "http", status: 403, body: '{"error":"forbidden"}', file: "F1" }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle", times: 2 },
    ],
  },
  {
    name: "403 for one event inside a 200: only that event is quarantined",
    drain: "http",
    events: { E1: {}, E2: { cell: "c2" }, E3: { cell: "c3" } },
    steps: [
      { do: "faults", events: [{ type: "reject", status: 403, reason: "self-validation is not allowed", ids: ["E2"] }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle" },
    ],
  },
  {
    name: "sync-token 403 (no access to the project): quarantined without a POST",
    drain: "http",
    events: { E1: { project: "P2", file: "F9" }, E2: {} },
    steps: [
      { do: "faults", token: [{ status: 403, body: '{"error":"No access to project"}', project: "P2" }] },
      { do: "enqueue", events: ["E1", "E2"] },
      { do: "cycle", times: 2 },
    ],
  },
  {
    name: "403 'role downgraded': one re-mint, one retry, accepted",
    drain: "http",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "reject", status: 403, reason: ROLE_DOWNGRADED, ids: "all" }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle" },
    ],
  },
  {
    name: "admin step-up required: that project's events wait, the rest drain",
    drain: "http",
    ...HELD_FOR_STEP_UP,
  },
  {
    name: "admin step-up required, then granted",
    drain: "http",
    events: HELD_FOR_STEP_UP.events,
    steps: [...HELD_FOR_STEP_UP.steps, { do: "faults", token: [] }, { do: "releaseHolds" }, { do: "cycle" }],
  },
  {
    name: "permanent 4xx for one event inside a 200: the one legal removal",
    drain: "http",
    events: { E1: {}, E2: { cell: "c2" }, E3: { cell: "c3" } },
    steps: [
      { do: "faults", events: [{ type: "reject", status: 422, reason: "payload.value must be a string", ids: ["E2"] }] },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle" },
    ],
  },
  {
    name: "whole-request 400 caused by one event: it burns its budget alone, then is held",
    drain: "http",
    events: { E1: {}, E2: { cell: "c2" } },
    steps: [
      { do: "faults", events: [{ type: "http", status: 400, body: '{"error":"bad request"}', id: "E1", times: "always" }] },
      { do: "enqueue", events: ["E1", "E2"] },
      { do: "cycle", times: 6 },
    ],
  },
  {
    name: "stale sibling: logged by the server, reported, not re-sent",
    drain: "http",
    events: { E1: {}, E2: { parent: "a-head-E1-replaced" }, E3: { cell: "c2" } },
    steps: [
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "cycle" },
    ],
  },
  {
    name: "cell event with no fileId on its envelope",
    drain: "http",
    events: { E1: { file: null }, E2: {} },
    steps: [
      { do: "enqueue", events: ["E1", "E2"] },
      { do: "cycle", times: 2 },
    ],
    knownLoss: {
      E1: "FINDING: flushOutboxBatch deletes a non-comment event that has no fileId without sending it and without telling anyone",
    },
  },
  {
    name: "project-scoped comment with no fileId is posted",
    drain: "http",
    events: {
      E1: { kind: "comment.resolve", file: null, cell: null, payload: { commentId: "comment-1", resolved: true } },
      E2: {},
    },
    steps: [
      { do: "enqueue", events: ["E1", "E2"] },
      { do: "cycle", times: 2 },
    ],
  },
  {
    name: "stored fractional milliseconds are rounded on the way out",
    drain: "http",
    events: {
      E1: {
        kind: "cell.audio.attach",
        payload: { audioId: "audio-1", url: "r2://audio-1", slot: "recording", durationMs: 2403.5, startTime: 1.25 },
      },
    },
    steps: [
      { do: "enqueue", events: ["E1"] },
      { do: "cycle" },
    ],
  },
  {
    name: "enqueue while a POST is in flight",
    drain: "http",
    events: { E1: {}, E2: {}, E3: {}, E4: { cell: "c2" } },
    steps: [
      { do: "faults", events: [{ type: "hang", commit: false }] },
      { do: "enqueue", events: ["E1", "E2"] },
      { do: "cycle" },
      { do: "enqueue", events: ["E3", "E4"] },
      { do: "release" },
    ],
  },
  {
    name: "three flushes started at the same instant in one tab",
    drain: "http",
    events: THREE,
    steps: [
      { do: "enqueue", events: ["E1", "E2", "E3"], as: "batch" },
      { do: "cycle", together: 3 },
    ],
  },

  // ── Flusher hook: useOutboxFlusher's Web-Lock loop, fake timers ─────────
  {
    name: "offline for the whole enqueue, drained by the 'online' event",
    drain: "hook",
    events: THREE,
    steps: [
      { do: "net", online: false },
      { do: "mount" },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      // Sleeps end at 5s and 10s and are skipped (offline); the next is due at 15s.
      { do: "advance", ms: 12_000 },
      { do: "net", online: true },
      // The reconnect stagger (1.25s with the pinned draw) — before the 15s sleep ends.
      { do: "advance", ms: 2_500 },
    ],
  },
  {
    name: "5xx twice: backoff doubles, the third attempt lands",
    drain: "hook",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "http", status: 500, times: 2 }] },
      { do: "mount" },
      { do: "enqueue", events: ["E1", "E2", "E3"], as: "batch" },
      { do: "advance", ms: 10_000 },
      { do: "advance", ms: 20_000 },
    ],
  },
  {
    name: "session expired, then re-auth: drained on the next tick, not after the backoff",
    drain: "hook",
    events: THREE,
    steps: [
      { do: "expireSession" },
      { do: "mount" },
      // The mint answers 401: the flusher backs off to a 10s sleep.
      { do: "enqueue", events: ["E1", "E2", "E3"], as: "batch" },
      // A new authEpoch restarts the loop. The old loop holds the Web Lock
      // until flushNow wakes it, so the new one starts with a fresh 5s sleep.
      { do: "reauth", jwt: "jwt-2" },
      { do: "advance", ms: 5_000 },
    ],
  },
  {
    name: "two tabs on one outbox: one lock holder flushes, the other takes over",
    drain: "hook",
    events: { E1: {}, E2: {}, E3: {}, E4: { cell: "c2" } },
    steps: [
      { do: "open", tab: "B" },
      { do: "net", online: false },
      { do: "mount", tab: "A" },
      { do: "mount", tab: "B" },
      { do: "enqueue", events: ["E1", "E2"], tab: "B" },
      // `online` reaches both tabs at the same instant. Only the lock holder
      // (A) may answer it with a flush: two would each POST the same rows.
      { do: "net", online: true },
      { do: "advance", ms: 2_500 },
      { do: "enqueue", events: ["E3"], tab: "A" },
      // A is closed; its lock is released when its sleep ends, and B takes it.
      { do: "unmount", tab: "A" },
      { do: "advance", ms: 5_000 },
      // B's wake-on-enqueue compares against the queue size B last saw (2),
      // which A's flushes never updated, so E4 goes on B's next tick instead.
      { do: "enqueue", events: ["E4"], tab: "B" },
      { do: "advance", ms: 5_000 },
    ],
  },
  {
    name: "page reload while a POST is in flight (the server had committed it)",
    drain: "hook",
    events: THREE,
    steps: [
      { do: "faults", events: [{ type: "hang", commit: true }] },
      { do: "mount", tab: "A" },
      { do: "enqueue", events: ["E1", "E2", "E3"], as: "batch" },
      { do: "crash", tab: "A" },
      { do: "open", tab: "B" },
      { do: "mount", tab: "B" },
      { do: "advance", ms: 5_000 },
    ],
  },
  {
    name: "page torn down before IndexedDB stored the write: journal recovery",
    drain: "hook",
    events: {
      E1: {},
      E2: { kind: "cell.validate", payload: { editEventId: "E1" } },
      E3: { cell: "c2" },
      E4: { cell: "c2", kind: "cell.validate", payload: { editEventId: "E3" } },
    },
    steps: [
      { do: "idb", opens: "hold" },
      { do: "enqueue", events: ["E1", "E2"], as: "unawaited" },
      { do: "enqueue", events: ["E3", "E4"], as: "batch" },
      { do: "crash", tab: "A" },
      { do: "open", tab: "B" },
      { do: "mount", tab: "B" },
      { do: "advance", ms: 5_000 },
    ],
    knownLoss: {
      E2: "KNOWN GAP: a single event that is not a target.cell.commit is not journaled (outbox-recovery.ts journalTargetCommit), so a page that dies before IndexedDB stores it loses it",
    },
  },
  {
    name: "second tab opens while the first is still writing: its journal entry is not replayed",
    drain: "hook",
    events: { E1: {} },
    steps: [
      { do: "idb", opens: "hold" },
      { do: "enqueue", events: ["E1"], as: "unawaited", tab: "A" },
      { do: "idb", opens: "pass" },
      { do: "open", tab: "B" },
      { do: "mount", tab: "B" },
      { do: "advance", ms: 5_000 },
      { do: "idb", opens: "proceed" },
      { do: "advance", ms: 5_000 },
      { do: "advance", ms: 5_000 },
    ],
  },

  // ── Socket: the real reconciler under the harness's WS-first sender ─────
  {
    name: "socket unavailable: the HTTP drain carries the queue",
    drain: "ws",
    events: THREE,
    steps: [
      { do: "wsServer", up: false },
      { do: "ws", action: "connect" },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "ws", action: "pump" },
    ],
  },
  {
    name: "socket drops mid-send: the reconnect re-sends what was not acked",
    drain: "ws",
    events: THREE,
    steps: [
      // E1 is applied and acked, E2 is applied but its ack is lost, E3 never arrives.
      { do: "wsServer", lossy: { deliver: 2, ack: 1 } },
      { do: "ws", action: "connect" },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "ws", action: "pump" },
      { do: "ws", action: "drop" },
      // First reconnect window: 2.5s with the pinned draw.
      { do: "advance", ms: 2_500 },
    ],
  },
  {
    name: "socket drops mid-send and stays down: the HTTP drain re-sends",
    drain: "ws",
    events: THREE,
    steps: [
      { do: "wsServer", lossy: { deliver: 1, ack: 0 } },
      { do: "ws", action: "connect" },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "ws", action: "pump" },
      { do: "wsServer", up: false },
      { do: "ws", action: "drop" },
      { do: "ws", action: "pump" },
    ],
  },
  {
    name: "event.stale for a chain-mutating event",
    drain: "ws",
    events: { E1: {}, E2: { parent: "a-head-E1-replaced" }, E3: { cell: "c2" } },
    steps: [
      { do: "ws", action: "connect" },
      { do: "enqueue", events: ["E1", "E2", "E3"] },
      { do: "ws", action: "pump" },
    ],
  },
]
