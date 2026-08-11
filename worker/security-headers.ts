// Response security headers for aquilla-web (the SPA + marketing Worker).
//
// Context: the Tauri desktop shell has carried a real CSP since June
// (src-tauri/tauri.conf.json → app.security.csp), but the browser build shipped
// with no CSP and no transport/framing hardening at all. That leaves the web
// app — the surface that actually holds 30-day session JWTs in IndexedDB and
// user-supplied provider API keys in localStorage — without the standard second
// layer behind input sanitisation. See docs/OPSEC-REVIEW-2026-08-10.md (OPS-1).
//
// Two-tier rollout, deliberately:
//
//   ENFORCED  — the directives that cannot break a working page: no plugins,
//               no <base> hijack, no third-party framing, plus the transport
//               and referrer headers. Shipping these is pure gain.
//   REPORT-ONLY — the full policy (script-src/style-src/connect-src/…). The
//               SPA talks to a build-time-configurable set of hosts (identity
//               and sync Workers, PostHog, Hugging Face / R2 model hosts,
//               door43, OpenRouter via the proxy) and the marketing pages are
//               prerendered, so enforcing a full policy blind would risk a
//               production outage for a defence-in-depth control. Report-only
//               surfaces every violation in devtools first; promote directives
//               into ENFORCED_CSP as each one comes back clean.
//
// Coverage note: `run_worker_first = ["/"]` (wrangler.toml) plus the asset
// router means this Worker sees `/`, the STATIC_PAGES marketing routes, and
// every SPA deep link (no asset match → Worker → ASSETS.fetch fallback).
// Hashed build assets and a literal `/index.html` request are served by the
// asset router without invoking the Worker, so they carry no headers — that is
// acceptable for CSP (the policy is enforced on the *document* response) and is
// tracked as the follow-up in the OPSEC review.

/** Directives safe to enforce today: none of them can break a page that isn't
 *  already doing something we don't want (plugin embeds, <base> rewriting,
 *  being framed by a third party, cross-origin form posts). */
const ENFORCED_CSP = [
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ")

/** The policy we intend to enforce. Mirrors the Tauri shell's CSP so the two
 *  shells converge, with the web-only additions (Google Fonts stylesheet,
 *  `'wasm-unsafe-eval'` for the onnxruntime-web / sherpa-onnx WASM runtimes,
 *  blob: workers for the audio pipeline). Report-only until the console is
 *  clean on both the SPA and the prerendered marketing pages. */
const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  // Deliberately host-agnostic for now: the API base, sync host, PostHog host
  // and model hosts are all injected at build time (VITE_*), so pinning them
  // here would silently break a rebranded or staging build. Narrowing this to
  // an explicit allowlist is the highest-value follow-up.
  "connect-src 'self' https: wss:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ")

// Microphone stays enabled for this origin — cell audio recording and the MMS
// dictation flow both call getUserMedia (src/components/AudioRecorder/*).
// Everything else the app never asks for, so denying it costs nothing and
// removes the capability from any injected script.
const PERMISSIONS_POLICY = [
  "microphone=(self)",
  "camera=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "interest-cohort=()",
].join(", ")

// One year. Deliberately without `includeSubDomains`/`preload` in this pass:
// both are effectively irreversible for the lifetime of the max-age and would
// cover subdomains this repo does not own the TLS posture of. Tracked as a
// follow-up in the OPSEC review once every *.aquilla.app host is confirmed
// HTTPS-only.
const HSTS = "max-age=31536000"

// Statuses that must not carry a body — `new Response(body, init)` throws for
// these, so the clone has to pass null instead of res.body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Clone `res` with the security headers applied. Cloning is required because
 * responses from the static-asset binding have immutable headers.
 *
 * `hostname` decides only whether HSTS is sent: it is meaningless (and
 * actively annoying) on a plaintext localhost dev server.
 */
export function withSecurityHeaders(res: Response, hostname: string): Response {
  const body = NULL_BODY_STATUSES.has(res.status) ? null : res.body
  const out = new Response(body, res)
  out.headers.set("Content-Security-Policy", ENFORCED_CSP)
  out.headers.set("Content-Security-Policy-Report-Only", REPORT_ONLY_CSP)
  out.headers.set("X-Content-Type-Options", "nosniff")
  out.headers.set("X-Frame-Options", "SAMEORIGIN")
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  out.headers.set("Permissions-Policy", PERMISSIONS_POLICY)
  if (!isLocalHost(hostname)) out.headers.set("Strict-Transport-Security", HSTS)
  return out
}

export function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  )
}
