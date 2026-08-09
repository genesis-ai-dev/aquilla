// Baseline security response headers for the aquilla-web surface.
//
// Two delivery paths, because `run_worker_first = ["/"]` (wrangler.toml) means
// the Worker only runs for the bare root — every other path is answered by the
// static-asset router without this module ever executing:
//
//   /            → Worker → `withSecurityHeaders()` below
//   /* (rest)    → asset router → `public/_headers`
//
// Both must be kept in sync; `security-headers.test.ts` asserts they agree.
//
// Addresses SEC-6 of docs/SECURITY-NOTES-2026-06-10.md ("No CSP anywhere;
// long-lived tokens and API keys in script-readable storage"). Full context and
// the path to enforcement: docs/SECURITY-REVIEW-2026-08-09.md.

/**
 * Enforced CSP. Deliberately narrow: `frame-ancestors` is the one directive we
 * can turn on today with zero breakage risk, because nothing in the product is
 * framed or frames anything (no `<iframe>` in src/ or any marketing page). It
 * is also the only clickjacking control that works in modern browsers —
 * `X-Frame-Options` below is the legacy belt to this suspenders.
 *
 * The full policy ships alongside as Report-Only (see `REPORT_ONLY_CSP`).
 * Enforcing it wholesale today would break production on the first deploy:
 * `index.html` and `homepage.html` each carry an inline bootstrap `<script>`
 * that a `script-src 'self'` policy blocks.
 */
export const ENFORCED_CSP = "frame-ancestors 'none'"

/**
 * The policy we intend to enforce, shipped in Report-Only mode so real traffic
 * tells us what it breaks before it breaks anyone.
 *
 * Known violations it will report from day one — both are the point, not
 * oversights:
 *  1. The inline theme bootstrap in `index.html` / `homepage.html`. Resolve by
 *     hashing it or moving it to an external module before enforcing.
 *  2. Any host reached through a user-configured base URL (ProjectSettings
 *     allows an arbitrary OpenAI-compatible endpoint), which by definition
 *     cannot be enumerated here.
 *
 * `connect-src` covers what the SPA actually talks to today: the API Workers on
 * `*.aquilla.app` (HTTP + the sync WebSocket), PostHog, Gemini TTS, the
 * OpenRouter/OpenAI chat paths, the door43/helloao scripture sources, and Modal
 * for diarization. `wasm-unsafe-eval` is required by onnxruntime-web and the
 * whisper/diarization workers; `worker-src blob:` by their blob-URL workers.
 */
export const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  // Tailwind and React both set element-level styles at runtime; 'unsafe-inline'
  // for styles is a deliberate, low-severity concession (no script execution).
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  [
    "connect-src 'self'",
    "https://*.aquilla.app",
    "wss://*.aquilla.app",
    "https://*.posthog.com",
    "https://generativelanguage.googleapis.com",
    "https://openrouter.ai",
    "https://api.openai.com",
    "https://git.door43.org",
    "https://cdn.door43.org",
    "https://bible.helloao.org",
    "https://*.modal.run",
  ].join(" "),
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ")

/**
 * Headers applied to every response. Values are intentionally conservative —
 * anything that could plausibly break a working feature ships as Report-Only
 * (CSP) or is omitted entirely (see the HSTS note).
 *
 * `microphone=(self)` is load-bearing: cell audio recording and the diarization
 * flow call `getUserMedia` (src/components/AudioRecorder/, CellAudioRecordButton).
 * `autoplay=(self)` keeps TTS/audio playback working.
 *
 * Strict-Transport-Security is intentionally NOT set here. Cloudflare manages
 * HSTS at the zone level, and `includeSubDomains` from a Worker would reach
 * every *.aquilla.app subdomain — a change that must be made deliberately at
 * the zone, not as a side effect of a headers refactor.
 *
 * Cross-Origin-Opener-Policy is intentionally NOT set either. The Monday OAuth
 * flow opens a popup deliberately WITHOUT `noopener` because it needs the live
 * handle to navigate it (`src/pages/settings/OrgSettingsMonday.tsx:114` — the
 * comment there is explicit). `same-origin` severs the browsing-context group
 * when that popup goes cross-origin, and the exact severance timing relative to
 * the `popup.location.href` assignment is not something we can verify without
 * driving a real browser through a real Monday consent screen. COOP is a small
 * gain next to the rest of this policy; risking a working OAuth flow for it is
 * a bad trade. Revisit with a browser test, not by reasoning about the spec.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": ENFORCED_CSP,
  "Content-Security-Policy-Report-Only": REPORT_ONLY_CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": [
    "accelerometer=()",
    "autoplay=(self)",
    "camera=()",
    "display-capture=()",
    "geolocation=()",
    "gyroscope=()",
    "magnetometer=()",
    "microphone=(self)",
    "payment=()",
    "usb=()",
  ].join(", "),
})

/** Statuses whose body must be null — cloning one with a body throws. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Return `res` with the baseline security headers applied.
 *
 * Response headers off a `fetch()` are immutable, so this clones. Existing
 * values are overwritten: these headers are a floor, and an asset-level value
 * should not silently weaken the site-wide policy.
 */
export function withSecurityHeaders(res: Response): Response {
  const body = NULL_BODY_STATUSES.has(res.status) ? null : res.body
  const out = new Response(body, res)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value)
  }
  return out
}
