// How the identity worker calls the sync worker.
//
// On the deployed environments both Workers are mounted as routes on one
// hostname (`api.<env>.aquilla.app/identity/*` and `/sync/*`). Cloudflare does
// not deliver a plain `fetch()` from one Worker to another Worker's route on
// the same zone: the request is answered by the zone's origin instead, which
// here does not exist. Only a service binding reaches it. The same rule cost
// the sync → identity direction AQU-2191 and AQU-2216 (a 522 on every call);
// sync-worker's `fetchIdentity` is this function's mirror image.
//
// So every identity → sync call goes through the `SYNC_WORKER` binding when the
// environment declares one (wrangler.toml `[[env.<env>.services]]`), and falls
// back to the URL where it does not — local `wrangler dev`, e2e and self-hosted
// setups, where the two Workers are on different origins and a plain fetch is
// the right call. The URL is passed either way: the sync worker routes on its
// path (and strips its own `/sync` mount prefix), so the same absolute URL
// works through the binding.

import type { Env } from "../types"

export function syncWorkerFetch(
  env: Pick<Env, "SYNC_WORKER">,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return env.SYNC_WORKER ? env.SYNC_WORKER.fetch(url, init) : fetch(url, init)
}
