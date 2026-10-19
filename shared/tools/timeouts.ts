// AQU-1937: the Smart Extensions timeout ladder, in one place so every layer
// gives up AFTER the layer below it. A slow site must surface as the
// innermost layer's own clear error ("took longer than 40 s, 3.1 MB received;
// ask for less"), never as an opaque outer "timed out".
//
//   proxy (auth-worker)        DNS ≤ 5 s + upstream ≤ 15 s (UI) / 40 s (importers)
//   bridge call (frame)        web.fetch 60 s > 45 s; every other call 30 s
//   headless job (host)        choices 75 s > one web.fetch; runs: minutes
//
// Time the user spends on a permission prompt counts against none of them
// (the bridge "hold"s the call; the job deadline pauses).

/** DNS over HTTPS, per query (A and AAAA run in parallel). */
export const WEB_FETCH_DNS_TIMEOUT_MS = 5_000
/** Upstream read for an extension's UI (panels, editors). */
export const WEB_FETCH_TIMEOUT_MS = 15_000
/** Upstream read for an IMPORTER (declares write:files): catalogs and whole
 *  books are bigger, and the user is watching a progress bar, not a panel. */
export const WEB_FETCH_IMPORTER_TIMEOUT_MS = 40_000
/** The frame's deadline for one aquilla.web.fetch: above the slowest proxy answer. */
export const BRIDGE_WEB_FETCH_TIMEOUT_MS = 60_000
/** The frame's deadline for every other bridge call. */
export const BRIDGE_CALL_TIMEOUT_MS = 30_000
/** A dynamic-choices job: above one web.fetch, so the fetch's own error wins. */
export const CHOICES_TIME_LIMIT_MS = 75_000
