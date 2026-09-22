/**
 * Off-machine fetch guard (AQU-1277).
 *
 * A unit test that forgets a `fetch` mock — or whose `mockResolvedValueOnce`
 * chain runs out — falls through to the real `fetch`. Because
 * `src/lib/deployment-environment.ts`, `src/lib/frontier/auth.ts` and
 * `src/lib/sync/sync-token.ts` all default to `https://api.aquilla.app/identity`
 * when `VITE_AUTH_BASE` is unset, those calls land on **production** identity
 * carrying fixture ids and fake tokens. The symptom is a permanent 401 warn
 * stream on `aquilla-identity`; the risk is a run that happens to hold a valid
 * developer token mutating production data.
 *
 * Installing this as the global `fetch` turns that silent production hit into a
 * failing test. Requests that resolve to this machine still go through, so a
 * test pointed at a local sink keeps working, and non-network schemes
 * (`data:`, `blob:`, `file:`) are left alone.
 */

/** Hosts that are unambiguously this machine. */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
])

/** Schemes that never leave the process, so the guard has no opinion on them. */
const NON_NETWORK_PROTOCOLS: ReadonlySet<string> = new Set(["data:", "blob:", "file:"])

export class OffMachineRequestError extends Error {
  readonly method: string
  readonly url: string

  constructor(method: string, url: string, where: string) {
    super(
      `[AQU-1277] Blocked off-machine request from a unit test: ${method} ${url}\n` +
        `  in: ${where}\n` +
        `  A fetch mock is missing or its mockResolvedValueOnce chain ran out, so this\n` +
        `  call would have hit the real host (production identity answers 401 and logs it).\n` +
        `  Fix the test by mocking fetch for this call — do not relax the guard.`,
    )
    this.name = "OffMachineRequestError"
    this.method = method
    this.url = url
  }
}

/**
 * happy-dom serves tests from `http://localhost:3000`, so a relative URL is
 * already local. Fall back to that literal when `location` is unavailable
 * (e.g. a node-environment test file).
 */
function pageOrigin(): string {
  return globalThis.location?.href ?? "http://localhost:3000/"
}

function describeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): { method: string; url: string } {
  // A Request carries its own method/url, but an explicit init.method still wins.
  const isRequest = typeof Request !== "undefined" && input instanceof Request
  const rawUrl = isRequest ? input.url : String(input)
  const method = init?.method ?? (isRequest ? input.method : "GET")
  return { method: method.toUpperCase(), url: rawUrl }
}

/**
 * True when the request stays on this machine. An unparseable URL is treated as
 * off-machine: failing loudly on something we cannot classify is the safe side
 * of this guard.
 */
function staysOnThisMachine(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl, pageOrigin())
  } catch {
    return false
  }
  if (NON_NETWORK_PROTOCOLS.has(parsed.protocol)) return true
  return LOCAL_HOSTNAMES.has(parsed.hostname)
}

/**
 * Violations seen during the current test. The guard throws at the call site,
 * but application code frequently wraps `fetch` in try/catch and swallows the
 * error — which would leave the test green despite a blocked production call.
 * `src/test-setup.ts` drains this in `afterEach` and fails the test there, so a
 * swallowed violation is still fatal.
 */
const violations: string[] = []

/** Drains recorded violations. Returns them and resets for the next test. */
export function takeOffMachineRequestViolations(): string[] {
  return violations.splice(0, violations.length)
}

function defaultDescribeTest(): string {
  return "unknown test (vitest expect state unavailable)"
}

/**
 * Wraps `realFetch` so only same-machine requests reach it.
 *
 * `describeTest` is injected so the factory stays testable without vitest's
 * expect state; `src/test-setup.ts` supplies the real one.
 */
export function createOffMachineFetchGuard(
  realFetch: typeof fetch,
  describeTest: () => string = defaultDescribeTest,
): typeof fetch {
  return function guardedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const { method, url } = describeRequest(input, init)
    if (staysOnThisMachine(url)) return realFetch(input, init)

    const where = describeTest()
    violations.push(`${method} ${url} (in ${where})`)
    throw new OffMachineRequestError(method, url, where)
  }
}
