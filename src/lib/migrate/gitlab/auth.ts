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
//   FRONTIER_API                           -> overrides the API endpoint
//                                             (default https://api.frontierrnd.com/api/v1)

export const DEFAULT_FRONTIER_API = "https://api.frontierrnd.com/api/v1"

/** Resolved credentials usable against the self-hosted GitLab + git + LFS. */
export interface GitLabCredentials {
  /** GitLab personal-access token (use as `Bearer` / `oauth2:<token>`). */
  gitlabToken: string
  /** GitLab base URL, e.g. https://git.genesisrnd.com (no trailing slash). */
  gitlabUrl: string
  /** Frontier API access token (kept for completeness; not needed downstream). */
  accessToken: string
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
  }
}

/**
 * Resolve GitLab credentials from the environment. Preferred path is the
 * Frontier password grant (FRONTIER_USERNAME + FRONTIER_PASSWORD). A direct
 * escape hatch (FRONTIER_TOKEN + GITLAB_URL) skips the Frontier round-trip
 * entirely — handy when you already hold a GitLab token.
 *
 * @throws with an actionable message if neither credential set is present.
 */
export async function resolveCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitLabCredentials> {
  const directToken = env.FRONTIER_TOKEN?.trim()
  const directUrl = env.GITLAB_URL?.trim()
  if (directToken && directUrl) {
    return {
      gitlabToken: directToken,
      gitlabUrl: trimTrailingSlash(directUrl),
      accessToken: "",
    }
  }

  const username = env.FRONTIER_USERNAME?.trim()
  const password = env.FRONTIER_PASSWORD
  if (username && password) {
    const apiEndpoint = env.FRONTIER_API?.trim() || DEFAULT_FRONTIER_API
    return loginToFrontier(username, password, apiEndpoint)
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
