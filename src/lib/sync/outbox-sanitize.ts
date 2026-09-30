// Repairing events that were already written to the outbox. (AQU-1368)
//
// AQU-927 stopped fractional milliseconds at the two places they are MINTED —
// `denoise.ts` at the source and `intMs()` at the emit boundary. That fixes
// every event created after the fix and nothing created before it. Events
// minted earlier sit durably in users' IndexedDB outboxes with `2403.5`
// already baked into the payload, and an outbox record is never rewritten: it
// is posted verbatim, forever, until it is accepted or dead-lettered.
//
// Postgres refuses `2403.5` for a bigint column and the batch INSERT is
// atomic, so the refusal is not confined to the poisoned event — every valid
// audio event batched alongside it goes down too. A partner (lin184, Chinese
// Lg Project) hit this for ~5 weeks after the root cause was fixed: audio that
// would not upload, and a permanent "N failed" badge, from one row minted on
// 2026-08-15.
//
// So the emit-time guard needs a mirror at the FLUSH boundary. Rounding the
// outgoing payload turns the stranded event into one the server accepts,
// which rescues the user's audio instead of discarding it — the whole point
// of doing this here rather than dropping the record.
//
// WHY A SUFFIX RULE AND NOT A FIELD LIST. `intMs()` is applied by hand at each
// call site in `events-emit.ts`, which is how `durationMs` came to be missed
// in the first place. A list here would be the same mistake a second time and
// would need editing every time a payload grows a new millisecond field. Every
// such field in the grammar is named `…Ms` and every one of them lands in a
// bigint column, so the suffix is the rule the database actually enforces.
// Seconds-valued fields (`startTime`) are deliberately NOT touched: they are
// stored as reals and fractions are correct there.

import type { CqrsRawEvent } from "./outbox-types"
import { intMs } from "./events-emit"

/** Depth bound for the payload walk. Payload nesting is shallow (a few
 *  objects, or an array of segment objects); this only exists so a cyclic or
 *  pathological record can never spin the flusher. */
const MAX_DEPTH = 6

/** True for a number a bigint column will refuse. NaN/Infinity are left alone:
 *  rounding them produces another value the column refuses, so there is
 *  nothing to rescue and the server's own error is the more honest signal. */
function needsRounding(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)
}

function isMsKey(key: string): boolean {
  // `…Ms` as a word ending, so `durationMs`/`trimStartMs` match and a field
  // that merely contains the letters (`msgId`) does not.
  return /Ms$/.test(key)
}

/**
 * Round every fractional `…Ms` value in a payload, returning the SAME object
 * when there was nothing to fix.
 *
 * Identity preservation is load-bearing rather than tidiness: a flush of 100
 * clean events must not allocate 100 copies of their payloads on the way out,
 * and `sanitizeStoredEvents` uses referential equality to tell whether it
 * needs to rebuild the batch at all.
 */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value

  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const fixed = sanitizeValue(entry, depth + 1)
      if (fixed !== entry) changed = true
      return fixed
    })
    return changed ? next : value
  }

  const source = value as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (isMsKey(key) && needsRounding(entry)) {
      next[key] = intMs(entry)
      changed = true
      continue
    }
    const fixed = sanitizeValue(entry, depth + 1)
    if (fixed !== entry) changed = true
    next[key] = fixed
  }
  return changed ? next : value
}

/**
 * The outgoing form of one stored event: fractional `…Ms` payload values
 * rounded, `clientTs` rounded, everything else untouched.
 *
 * Returns the same event object when nothing needed fixing, so the common
 * path costs one walk and no allocation.
 */
export function sanitizeStoredEvent<E extends CqrsRawEvent>(event: E): E {
  const payload = sanitizeValue(event.payload, 0)
  // `clientTs` is `Date.now()` today and so always integral, but it lands in a
  // bigint column like the payload fields do and costs nothing to guard.
  const clientTs = needsRounding(event.clientTs) ? intMs(event.clientTs) : event.clientTs
  if (payload === event.payload && clientTs === event.clientTs) return event
  return { ...event, payload: payload as E["payload"], clientTs }
}

/** `sanitizeStoredEvent` over a batch, preserving order and array identity
 *  when every event was already clean. */
export function sanitizeStoredEvents(
  events: readonly CqrsRawEvent[],
): CqrsRawEvent[] {
  return events.map((event) => sanitizeStoredEvent(event))
}
