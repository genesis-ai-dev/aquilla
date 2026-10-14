// Jittered retry schedules (AQU-1838).
//
// Every client in a project loses its socket at the same instant when the
// sync-worker is redeployed, so any delay computed from a pure formula puts
// the whole fleet back on the wire together: 1,000 clients × (one socket +
// one token mint + one resync fan-out) inside the same few hundred ms, each
// opening a Postgres connection behind Hyperdrive. The schedules themselves
// are fine — what they lack is the independent random component that turns a
// synchronised fleet into a spread one.
//
// Two shapes are used:
//
// - **Full jitter** — draw uniformly from the whole window, and double the
//   WINDOW (not the delay) per failure. Best when the clients are known to be
//   in lockstep, which is exactly the post-deploy reconnect. The WebSocket
//   reconciler applies this inline (see `scheduleReconnect`).
// - **Proportional jitter** — keep the computed delay and scatter it ±spread.
//   Used where the delay is also a user-visible latency (the outbox drain
//   wakes at this cadence), so it must stay close to its nominal value.

/** Default ±30% scatter for the outbox retry schedule. */
export const OUTBOX_BACKOFF_JITTER = 0.3

/**
 * Scatter `delayMs` by ±`spread` (a fraction, so 0.3 = ±30%). Returns a
 * non-negative integer; a non-positive or non-finite input is passed through
 * as 0 so a caller that means "right now" is never pushed into the future.
 */
export function withJitter(
  delayMs: number,
  spread: number = OUTBOX_BACKOFF_JITTER,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0
  const factor = 1 + (random() * 2 - 1) * spread
  return Math.max(0, Math.round(delayMs * factor))
}

/**
 * Spread over which a fleet-wide `online` event staggers its outbox drain.
 * A shared outage (or a deploy that drops every socket) fires `online` on
 * every client at once, and the old handler answered it with an immediate
 * flush — so the queue POSTs arrived as one burst. Up to ~2.5s of delay on a
 * drain the user is not waiting for buys a spread fleet.
 */
export const ONLINE_FLUSH_SPREAD_MS = 2_500

/** A uniform draw from [0, spreadMs]. Used for the `online` stagger. */
export function staggerMs(
  spreadMs: number = ONLINE_FLUSH_SPREAD_MS,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(spreadMs) || spreadMs <= 0) return 0
  return Math.round(random() * spreadMs)
}
