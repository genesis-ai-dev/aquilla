// NOTE: This file defines the protocol only. The `broadcastRealtime()` helper
// referenced in the CQRS plan is wired up in Task 5 (the POST /events route)
// because it requires access to the ProjectSync Durable Object binding.

import type { EventKind } from './types'

// Tables that can be invalidated via projection.dirty messages.
// Adding a new projection table requires adding it here so clients can
// invalidate the corresponding query keys.
export type ProjectionTable = 'events' | 'cells' | 'files' | 'cell_validators' | 'cell_audio'

// Single source of truth for valid ProjectionTable runtime values. The Set
// and the type must stay in sync — adding a new table requires updating both.
// The exhaustiveness sanity test in realtime.test.ts catches drift.
const PROJECTION_TABLES: ReadonlySet<string> = new Set<ProjectionTable>([
  'events',
  'cells',
  'files',
  'cell_validators',
  'cell_audio',
])

// Discriminated union for client-bound Realtime messages. Adding a new
// variant requires bumping `v` (or adding a parallel `v: 2` variant) so
// older clients don't crash on unknown shapes.
export type RealtimeMessage =
  | {
      v: 1
      t: 'event'
      id: string                  // event ID (UUIDv7)
      kind: EventKind
      project: string
      file?: string
      cell?: string
      ts: number                  // server_ts (unix ms)
      /** Username of the actor that produced the event. Optional for back-
       *  compat with older producers; clients use it to filter their own
       *  writes out of remote-change banners. */
      by?: string
    }
  | {
      v: 1
      t: 'projection.dirty'
      project: string
      file?: string
      tables: ProjectionTable[]
    }

/**
 * Serialize a Realtime message to the wire format. Currently JSON.stringify;
 * keeping it behind a function so we can swap to MessagePack or a length-
 * prefixed binary frame later without touching call sites.
 */
export function serializeRealtimeMessage(msg: RealtimeMessage): string {
  return JSON.stringify(msg)
}

/**
 * Parse a Realtime message from its wire form. Returns null if the input
 * isn't a valid RealtimeMessage shape (validates `v`, `t`, and required
 * fields by tag). Defensive — the producer is in our own codebase but
 * client-side replay buggy proxies and middleware can corrupt frames.
 */
export function parseRealtimeMessage(raw: string): RealtimeMessage | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const m = obj as Record<string, unknown>
  if (m.v !== 1) return null
  if (m.t === 'event') {
    if (
      typeof m.id !== 'string' ||
      typeof m.kind !== 'string' ||
      typeof m.project !== 'string' ||
      typeof m.ts !== 'number'
    ) return null
    return {
      v: 1,
      t: 'event',
      id: m.id,
      kind: m.kind as EventKind,
      project: m.project,
      file: typeof m.file === 'string' ? m.file : undefined,
      cell: typeof m.cell === 'string' ? m.cell : undefined,
      ts: m.ts,
      ...(typeof m.by === 'string' ? { by: m.by } : {}),
    }
  }
  if (m.t === 'projection.dirty') {
    if (
      typeof m.project !== 'string' ||
      !Array.isArray(m.tables) ||
      !m.tables.every((t): t is ProjectionTable =>
        typeof t === 'string' && PROJECTION_TABLES.has(t)
      )
    ) return null
    return {
      v: 1,
      t: 'projection.dirty',
      project: m.project,
      file: typeof m.file === 'string' ? m.file : undefined,
      tables: m.tables as ProjectionTable[],
    }
  }
  return null
}

export { PROJECTION_TABLES }
