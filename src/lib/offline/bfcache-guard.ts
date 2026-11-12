// Keeps a frozen page's LiveStore leader from holding the OPFS files hostage.
//
// A full-page navigation (`location.assign`, a plain `<a href>`) in WKWebView
// puts the old page into the back-forward cache (`pagehide.persisted`). The
// frozen page's leader worker keeps its OPFS sync-access handles, so every
// later page load in the same WebContent process — reloads included — fails
// to boot a leader (`InvalidStateError` in LiveStore's
// `#acquireAccessHandles`, which has no retry) and local writes silently stop
// persisting until the app restarts. livestorejs/livestore#244.
//
// Opting out of the bfcache doesn't work: WebKit still caches a page with an
// `unload` listener (tried 2026-10-01). Instead, on a *persisted* pagehide we
// terminate the leader so its handles are released, and if WebKit ever
// restores that page we reload it, since its store has no leader any more.
// An ordinary pagehide (reload, quit) is left alone — terminating there was
// tried on 2026-09-29 and removed; quit has its own handshake in shutdown.ts.
//
// Commits that haven't reached the leader at that instant are lost, but the
// alternative is a dead leader for the rest of the process, which loses
// everything after it.

let leaderWorker: Worker | undefined
let installed = false

/** Records the leader worker the adapter just spawned (see store.ts). */
export function trackLeaderWorker(worker: Worker): void {
  leaderWorker = worker
}

export interface BfcacheGuardOptions {
  target?: Window
  reload?: () => void
}

/** Installs the pagehide/pageshow listeners once per page. */
export function installBfcacheGuard({ target = window, reload = () => target.location.reload() }: BfcacheGuardOptions = {}): void {
  if (installed) return
  installed = true
  let terminated = false
  target.addEventListener("pagehide", (event) => {
    if (!(event as PageTransitionEvent).persisted || !leaderWorker) return
    leaderWorker.terminate()
    leaderWorker = undefined
    terminated = true
    if (import.meta.env.DEV) console.info("[offline] page entering bfcache — terminated LiveStore leader")
  })
  target.addEventListener("pageshow", (event) => {
    if (!(event as PageTransitionEvent).persisted || !terminated) return
    if (import.meta.env.DEV) console.info("[offline] page restored from bfcache without a leader — reloading")
    reload()
  })
}

/** Test seam. */
export function __resetBfcacheGuardForTests(): void {
  leaderWorker = undefined
  installed = false
}
