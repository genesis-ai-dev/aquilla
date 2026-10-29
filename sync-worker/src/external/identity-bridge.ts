/** Service bindings reach the sibling Worker directly. Global same-zone fetch
 * can bypass its route; local development still uses its HTTP listener. */
export interface IdentityTransport {
  AUTH_WORKER?: Pick<Fetcher, 'fetch'>
}

export function fetchIdentity(
  env: IdentityTransport, url: string, init: RequestInit,
): Promise<Response> {
  return env.AUTH_WORKER
    ? env.AUTH_WORKER.fetch(url, init)
    : fetch(url, init)
}
