import type { PostHog } from "posthog-js"
import { analyticsAccount } from "./analytics-account"
import { AUTH_BASE } from "./frontier/auth"
import { resolveAppEnv } from "./analytics-env"
import { installResizeObserverNoiseGuard } from "./analytics-noise"
import { redactCaptureEvent } from "./analytics-redaction"
import { resolvePosthogHost } from "./posthog-host"

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const HOST = resolvePosthogHost(import.meta.env.VITE_POSTHOG_HOST as string | undefined)
let loaded: PostHog | null = null
let generation = -1
let starting = -1

function current(expected = generation): boolean {
  return expected === analyticsAccount.getSnapshot().generation && analyticsAccount.eligible()
}

// Deliberately no queue: unapproved events/errors cannot be replayed after approval.
const posthog = {
  capture: (...args: Parameters<PostHog["capture"]>): void => { if (current()) loaded?.capture(...args) },
  captureException: (...args: Parameters<PostHog["captureException"]>): void => { if (current()) loaded?.captureException(...args) },
  // Identity belongs to the account controller, never a late login callback.
  identify: (..._args: Parameters<PostHog["identify"]>): void => {},
  register: (...args: Parameters<PostHog["register"]>): void => { if (current()) loaded?.register(...args) },
  reset: (): void => analyticsAccount.invalidate(),
  get_session_replay_url: (): string | undefined => current() ? loaded?.get_session_replay_url() : undefined,
  /** Capture this before asynchronous work; completion cannot cross accounts. */
  scope: (expected = analyticsAccount.getSnapshot().generation, owner?: string) => {
    const approved = analyticsAccount.eligible() && (owner === undefined || owner === analyticsAccount.getSnapshot().username)
    return {
      owner: analyticsAccount.getSnapshot().username,
      enabled: () => approved && current(expected),
      capture: (...args: Parameters<PostHog["capture"]>) => { if (approved && current(expected)) posthog.capture(...args) },
      captureException: (...args: Parameters<PostHog["captureException"]>) => { if (approved && current(expected)) posthog.captureException(...args) },
    }
  },
}

function stop(): void {
  const old = loaded
  loaded = null
  if (!old) return
  // The SDK's shutdown flushes. Every dispatch (including retry/beacon) has the
  // generation guard below, so teardown discards rather than sending that data.
  try { old.sessionRecording?.dispose({ discardBufferedEvents: true }) } catch { /* dispatch remains blocked */ }
  try { old.stopSessionRecording() } catch { /* dispatch remains blocked */ }
  try { void Promise.resolve(old.shutdown()).catch(() => {}) } catch { /* optional teardown must not break account switching */ }
  old.__loaded = false
}

async function reconcile(): Promise<void> {
  const state = analyticsAccount.getSnapshot()
  if (generation !== state.generation || !analyticsAccount.eligible()) stop()
  if (!KEY || !analyticsAccount.eligible() || loaded || starting === state.generation) return
  const expected = state.generation
  starting = expected
  try {
    // Bundle the recorder locally: no late external script can restart it after
    // withdrawal, and no SDK asset is requested before approval.
    const [{ PostHog }, identity] = await Promise.all([
      import("posthog-js/full/no-external"),
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${AUTH_BASE}:${state.accountId}`)),
    ])
    if (!current(expected)) return
    const ph = new PostHog()
    const allowed = () => current(expected)
    generation = expected
    const distinctId = Array.from(new Uint8Array(identity), b => b.toString(16).padStart(2, "0")).join("")
    ph.init(KEY, {
      bootstrap: { distinctID: distinctId, isIdentifiedID: true },
      api_host: HOST,
      api_transport: "fetch",
      persistence: "memory",
      disable_persistence: true,
      consent_persistence_name: `aquilla:runtime-consent:${crypto.randomUUID()}`,
      capture_pageview: false,
      capture_pageleave: false,
      autocapture: false,
      // Global errors can originate in another account's background uploads.
      // Explicit, operation-scoped captureException remains available.
      capture_exceptions: false,
      capture_performance: false,
      enable_recording_console_log: false,
      disable_external_dependency_loading: true,
      disable_surveys: true,
      disable_conversations: true,
      disable_product_tours: true,
      advanced_disable_feature_flags: true,
      disable_compression: true,
      before_send: (event) => allowed() ? redactCaptureEvent(event) : null,
      disable_session_recording: true,
      session_recording: { recordHeaders: false, recordBody: false, maskAllInputs: true, maskTextSelector: "[data-ph-mask], [data-cell-type]" },
    })
    // Pinned SDK integration seam: the common dispatch path checks this for
    // initial sends, queued sends, retries and unload. Compression is disabled
    // so no async encoder can outlive that check. Covered with the real SDK.
    const limited = ph.rateLimiter.isServerRateLimited.bind(ph.rateLimiter)
    ph.rateLimiter.isServerRateLimited = (...args) => !allowed() || limited(...args)
    loaded = ph
    ph.register({ app_env: resolveAppEnv(window.location) })
    ph.identify(distinctId)
    ph.capture("$pageview")
    ph.startSessionRecording()
  } catch {
    // Optional analytics failure must not interfere with login or editing.
    stop()
  } finally {
    if (starting === expected) starting = -1
  }
}
if (typeof window !== "undefined" && KEY) {
  installResizeObserverNoiseGuard(window)
  analyticsAccount.subscribe(() => { void reconcile() })
  void reconcile()
}
export default posthog
