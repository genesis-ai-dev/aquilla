// Frontier authentication for the legacy-Codex -> Aquilla migration fetcher.
//
// Auth is NOT GitLab-direct. We POST to the Frontier API's password-grant token
// endpoint, which brokers a GitLab personal-access token + the self-hosted
// GitLab base URL back to us. Those broker credentials are what every
// subsequent GitLab REST / git-clone / git-LFS call uses.
//
// Ported from the VS Code extension's
//   frontier-authentication/src/auth/AuthenticationProvider.ts  (login())
// but stripped of all vscode/StateManager coupling — this is headless.
//
// ENV VARS (see scripts/migrate-fetch.ts for the full live runbook):
//   FRONTIER_USERNAME + FRONTIER_PASSWORD  -> exchanged here for GitLab creds
//   FRONTIER_TOKEN    + GITLAB_URL         -> a GitLab token used directly
//   FRONTIER_API                           -> overrides the API endpoint
//                                             (default https://api.frontierrnd.com/api/v1)
//
// Both sets may be present. The direct token is TRIED first, not trusted
// first: `resolveCredentialsFromEnv` verifies it against GitLab and falls
// through to the password grant when GitLab rejects it (AQU-1347).

export const DEFAULT_FRONTIER_API = "https://api.frontierrnd.com/api/v1"

/** Which env-var path produced the credentials — surfaced in auth failures so a
 *  401 from GitLab says WHICH secret to rotate. */
export type CredentialSource = "direct-token" | "frontier-login"

/** Human-readable name of the env vars behind a credential source. */
export function describeCredentialSource(source: CredentialSource | undefined): string {
  switch (source) {
    case "direct-token":
      return "FRONTIER_TOKEN + GITLAB_URL (direct GitLab token; tried first, falls back to FRONTIER_USERNAME/PASSWORD when GitLab rejects it)"
    case "frontier-login":
      return "FRONTIER_USERNAME + FRONTIER_PASSWORD (Frontier password grant)"
    default:
      return "unknown credential path"
  }
}

/** Resolved credentials usable against the self-hosted GitLab + git + LFS. */
export interface GitLabCredentials {
  /** GitLab personal-access token (use as `Bearer` / `oauth2:<token>`). */
  gitlabToken: string
  /** GitLab base URL, e.g. https://git.genesisrnd.com (no trailing slash). */
  gitlabUrl: string
  /** Frontier API access token (kept for completeness; not needed downstream). */
  accessToken: string
  /** Set by resolveCredentialsFromEnv / loginToFrontier; absent for hand-built creds. */
  source?: CredentialSource
}

/** Raw shape returned by `POST ${apiEndpoint}/auth/token`. */
interface FrontierTokenResponse {
  access_token: string
  token_type: string
  gitlab_token: string
  gitlab_url: string
}

/**
 * Exchange a Frontier username/password for GitLab credentials via the
 * password grant. Mirrors AuthenticationProvider.login() exactly:
 *   - application/x-www-form-urlencoded body
 *   - { username, password, grant_type: "password", scope: "" }
 *   - response must carry gitlab_token + gitlab_url
 *
 * @throws if the endpoint rejects the credentials or omits GitLab fields.
 */
export async function loginToFrontier(
  username: string,
  password: string,
  apiEndpoint: string = DEFAULT_FRONTIER_API,
): Promise<GitLabCredentials> {
  if (!username || !password) {
    throw new Error("Frontier login requires both a username and a password")
  }

  const endpoint = `${trimTrailingSlash(apiEndpoint)}/auth/token`
  const formData = new URLSearchParams({
    username,
    password,
    grant_type: "password",
    scope: "",
  })

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formData,
    })
  } catch (error) {
    throw new Error(
      `Could not reach Frontier auth endpoint ${endpoint}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }

  if (!response.ok) {
    const detail = await safeText(response)
    throw new Error(
      `Frontier login failed (${response.status} ${response.statusText})` +
        (detail ? `: ${detail}` : "") +
        ". Check FRONTIER_USERNAME / FRONTIER_PASSWORD.",
    )
  }

  const result = (await response.json()) as Partial<FrontierTokenResponse>

  if (!result.gitlab_token || !result.gitlab_url) {
    throw new Error(
      "Frontier login succeeded but the response was missing GitLab credentials " +
        "(gitlab_token / gitlab_url).",
    )
  }

  return {
    gitlabToken: result.gitlab_token,
    gitlabUrl: trimTrailingSlash(result.gitlab_url),
    accessToken: result.access_token ?? "",
    source: "frontier-login",
  }
}

/** The outcome of asking GitLab whether a token is actually good. */
export interface CredentialCheck {
  ok: boolean
  /**
   * Why it is not ok, in words safe to print: an HTTP status line, or the
   * reason GitLab could not be reached. NEVER the token. Undefined when ok.
   */
  reason?: string
}

/**
 * Ask GitLab whether these credentials work, via the cheapest authenticated
 * call there is (`GET /api/v4/user` — the token's own identity, one row, no
 * pagination).
 *
 * This exists because a token that is merely PRESENT is not a token that
 * WORKS, and the resolver used to treat the two as the same thing. Checking
 * here, once, is what lets `resolveCredentialsFromEnv` fall through to the
 * password grant instead of handing a dead token to the caller and letting it
 * surface hours later as a bare 401 from whatever call happened to be first.
 */
export async function verifyGitLabToken(
  creds: GitLabCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialCheck> {
  const url = `${trimTrailingSlash(creds.gitlabUrl)}/api/v4/user`
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${creds.gitlabToken}` },
    })
  } catch (error) {
    return {
      ok: false,
      reason:
        `could not reach ${url}: ` +
        (error instanceof Error ? error.message : String(error)),
    }
  }
  if (response.ok) return { ok: true }
  return { ok: false, reason: `${response.status} ${response.statusText}`.trim() }
}

/** Hooks for `resolveCredentialsFromEnv`, so tests can drive it without a network. */
export interface ResolveCredentialsOptions {
  /** Defaults to `verifyGitLabToken`. */
  verify?: (creds: GitLabCredentials) => Promise<CredentialCheck>
  /** Where the "which path did we use" line goes. Defaults to stderr. */
  log?: (message: string) => void
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * Resolve GitLab credentials from the environment, VERIFYING whichever path it
 * takes and falling through when the first one is dead.
 *
 * Order: the direct escape hatch (FRONTIER_TOKEN + GITLAB_URL) first, because
 * somebody who set it meant to skip the Frontier round-trip — then the Frontier
 * password grant (FRONTIER_USERNAME + FRONTIER_PASSWORD).
 *
 * WHY THE FALL-THROUGH EXISTS (AQU-1347). The nightly delta sync failed 60
 * runs in a row over two months (AQU-1344) for one reason: `FRONTIER_TOKEN`
 * had expired, and because the resolver returned it unchecked the moment it
 * was set, it SHADOWED a username/password pair that was valid the whole time.
 * Precedence without verification is just a single point of failure wearing a
 * preference's clothes. Now an expired direct token costs a log line, not a
 * nightly run.
 *
 * Every failure names the env vars behind it and never the values — the whole
 * point is an operator reading CI output learning WHICH secret to rotate.
 *
 * @throws when no credential set is present, or when every present one fails.
 */
export async function resolveCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCredentialsOptions = {},
): Promise<GitLabCredentials> {
  const verify = options.verify ?? ((creds) => verifyGitLabToken(creds))
  const log = options.log ?? defaultLog

  const directToken = env.FRONTIER_TOKEN?.trim()
  const directUrl = env.GITLAB_URL?.trim()
  const username = env.FRONTIER_USERNAME?.trim()
  const password = env.FRONTIER_PASSWORD
  const apiEndpoint = env.FRONTIER_API?.trim() || DEFAULT_FRONTIER_API
  const hasLogin = Boolean(username && password)

  let directFailure: string | undefined

  if (directToken && directUrl) {
    const direct: GitLabCredentials = {
      gitlabToken: directToken,
      gitlabUrl: trimTrailingSlash(directUrl),
      accessToken: "",
      source: "direct-token",
    }
    const check = await verify(direct)
    if (check.ok) {
      log("GitLab credentials: using FRONTIER_TOKEN + GITLAB_URL (direct token accepted).")
      return direct
    }
    directFailure = `FRONTIER_TOKEN was rejected by GitLab (${check.reason ?? "no response"})`
    if (!hasLogin) {
      throw new Error(
        `${directFailure}. Rotate FRONTIER_TOKEN, or set FRONTIER_USERNAME + ` +
          "FRONTIER_PASSWORD so the Frontier password grant can take over.",
      )
    }
    log(
      `${directFailure} — falling back to the FRONTIER_USERNAME + FRONTIER_PASSWORD ` +
        "password grant.",
    )
  }

  if (hasLogin) {
    let brokered: GitLabCredentials
    try {
      brokered = await loginToFrontier(username!, password!, apiEndpoint)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      // Both paths named in ONE message. Two separate failures reported one at
      // a time is how AQU-1344 stayed invisible: each run's log only ever
      // showed the first one, so the working path never got mentioned.
      throw new Error(
        directFailure === undefined
          ? why
          : `Both GitLab credential paths failed. ${directFailure}. ` +
            `Frontier password grant also failed: ${why}`,
        { cause: error },
      )
    }
    log(
      "GitLab credentials: using FRONTIER_USERNAME + FRONTIER_PASSWORD " +
        "(Frontier password grant accepted).",
    )
    return brokered
  }

  throw new Error(
    "No credentials found. Set FRONTIER_USERNAME + FRONTIER_PASSWORD " +
      "(preferred), or FRONTIER_TOKEN + GITLAB_URL to skip the Frontier step.",
  )
}

/** Strip a single trailing slash so URL concatenation stays predictable. */
export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ""
  }
}
