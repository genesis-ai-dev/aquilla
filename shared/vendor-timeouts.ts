// AQU-1849: the ONE place every outbound vendor deadline is written down.
//
// Why this file exists: a vendor that accepts the connection and then never
// answers is worse than one that refuses. `fetch` in Workers has no default
// timeout, so an unbounded call pins a Worker invocation (and its subrequest
// slot) until the platform kills it — the user sees a spinner that never
// resolves and the logs show nothing to alert on. Every vendor call therefore
// carries a deadline from `VENDOR_TIMEOUT_MS` below, and a blown deadline is
// reported to the caller as a 504 and logged with the vendor's name.
//
// Rules for the table:
//   * One entry per vendor *call shape*, not per call site — two routes hitting
//     the same endpoint share an entry.
//   * The value is a hard ceiling on a HEALTHY-but-slow upstream, not a target.
//     Set it above the slowest real response we have seen and below whatever
//     the client gives up at, so this deadline wins the race and the user reads
//     a reason instead of guessing.
//   * STREAMING calls get a FIRST-BYTE deadline, never a total one: a long
//     generation is not a hang. Use `vendorDeadline` and `clear()` it as soon
//     as the response headers arrive (see `routes/chat.ts`).
//
// Shared by both Workers (and importable from the SPA) — relative imports
// only, since the three packages do not share a path alias.

/** Per-vendor hard deadlines, in milliseconds. */
export const VENDOR_TIMEOUT_MS = {
  /** Modal diarization kick-off. Modal spawns the GPU job and answers at once;
   *  the turns arrive later on the callback, so this bounds the handshake only. */
  modalDiarizationStart: 20_000,
  /** Modal Seed-VC voice conversion (AQU-1854). A cold L40S has to load
   *  checkpoints off the Volume and run 50 diffusion steps; still far below
   *  Modal's own 600 s function timeout. */
  modalVoiceConvert: 120_000,
  /** Inworld TTS synthesis (AQU-1156). Above a real TTS-2 run on the longest
   *  text we accept, below the SPA's own `TTS_REQUEST_TIMEOUT_MS`. */
  inworldTts: 60_000,
  /** Monday GraphQL API. One request carries up to ~10 aliased mutations; the
   *  client may also sleep on a 429 *between* attempts, which this does not
   *  cover (each attempt gets its own deadline). */
  mondayGraphQL: 30_000,
  /** Monday OAuth token endpoint — a token exchange/refresh, never slow when healthy. */
  mondayTokenEndpoint: 15_000,
  /** sync-worker → identity Monday push nudge. Fires from the DO broadcast on
   *  the live edit path, so it must give up fast: a missed nudge is reconciled
   *  by identity's cron flush. */
  mondayPushNudge: 10_000,
  /** Bible Aquifer reads (bibletranslation.org). Interactive — a translator is
   *  waiting on the Search dock. */
  aquifer: 5_000,
  /** TaBiThA Copilot verse brief. Builds a brief per call, so much slower than
   *  a plain Aquifer read. */
  tabitha: 45_000,
  /** OpenRouter (and any OpenAI-shaped proxy) with `stream: false` — a TOTAL
   *  deadline, because nothing arrives until the whole completion is done. */
  openRouterNonStreaming: 120_000,
  /** OpenRouter with `stream: true` — FIRST BYTE only. Once frames flow the
   *  stream is unbounded; what this bounds is the provider's queue. Set well
   *  above a cold reasoning model's time-to-first-token, because the cost of
   *  being wrong is asymmetric: detecting a hang 15 s later costs the user
   *  nothing they can feel, while cutting off a slow-but-healthy generation
   *  loses work they were waiting on. */
  openRouterStreamFirstByte: 60_000,
  /** OpenRouter metadata reads (`/models`, credit/usage lookups). Small JSON. */
  openRouterMetadata: 15_000,
} as const

export type VendorName = keyof typeof VENDOR_TIMEOUT_MS

/** True for the DOMException an aborted/expired fetch rejects with. */
export function isAbortTimeout(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const name = (err as { name?: unknown }).name
  return name === "TimeoutError" || name === "AbortError"
}

/**
 * One line per blown deadline, with the vendor name in it so it can be
 * alerted on and counted per vendor. Deliberately a single stable prefix —
 * `[vendor-timeout]` — rather than each call site's own wording.
 */
export function logVendorTimeout(vendor: VendorName, err?: unknown): void {
  console.error(
    `[vendor-timeout] ${vendor} did not respond within ${VENDOR_TIMEOUT_MS[vendor]}ms`,
    err ?? "",
  )
}

/** Human-readable reason for the 504 body. */
export function vendorTimeoutMessage(vendor: VendorName): string {
  return `${vendor} did not respond within ${Math.round(VENDOR_TIMEOUT_MS[vendor] / 1000)}s`
}

export interface VendorDeadline {
  /** Pass as the fetch `signal`. */
  readonly signal: AbortSignal
  /** True only when THIS deadline fired — not when the linked signal aborted. */
  timedOut(): boolean
  /** Disarm. Idempotent. For a streaming call, call this the moment the
   *  response headers arrive so the deadline bounds first byte, not the stream. */
  clear(): void
}

/**
 * A deadline that can also be aborted by someone else's signal (the client
 * hanging up, an agent run being cancelled). `AbortSignal.timeout` alone
 * cannot do this, and it cannot be disarmed — which a first-byte deadline on a
 * streaming call needs.
 *
 * `timedOut()` distinguishes our deadline from the linked abort so a client
 * that navigated away is never logged or reported as a vendor timeout.
 */
export function vendorDeadline(vendor: VendorName, linked?: AbortSignal | null): VendorDeadline {
  const timeoutMs = VENDOR_TIMEOUT_MS[vendor]
  const controller = new AbortController()
  let fired = false
  let cleared = false
  const timer = setTimeout(() => {
    fired = true
    controller.abort(new DOMException(vendorTimeoutMessage(vendor), "TimeoutError"))
  }, timeoutMs)
  const forward = () => controller.abort(linked?.reason)
  if (linked) {
    if (linked.aborted) forward()
    else linked.addEventListener("abort", forward, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => fired,
    clear() {
      if (cleared) return
      cleared = true
      clearTimeout(timer)
      linked?.removeEventListener("abort", forward)
    },
  }
}
