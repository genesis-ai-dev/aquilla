import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import { openExternal } from "@/lib/open-external"

export interface AgentConnectionRequest {
  agentName: string
  mode: "ask" | "act"
  requestedProjectId: string | null
  expiresAt: string
}
export async function connectionRequest<T>(jwt: string, path: string, body: object): Promise<T> {
  const response = await fetchWithTimeout(`${AUTH_BASE}/api/v2/agent-connect/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(String(response.status))
  return response.json() as Promise<T>
}

/** An MCP host's authorization request as the consent page described it. */
export interface McpOAuthClient {
  /** Self-declared; never shown without clientHost. */
  clientName: string
  /** Domain that served the client's metadata document — the verified part. */
  clientHost: string
  /** Where the browser goes back to after the decision. */
  redirectHost: string
  mode: "act"
  organizations: { id: string; name: string | null }[]
}

export type McpOAuthResult<T> =
  | { ok: true; data: T }
  /** `redirect` is set when the error must go back to the client (OAuth). */
  | { ok: false; status: number; redirect?: string }

/** Session call to the identity worker's MCP OAuth consent API. Unlike
 *  connectionRequest, an error body is returned rather than thrown: a 400 may
 *  carry the URL that hands the error back to the requesting app. */
export async function mcpOAuthCall<T>(jwt: string, path: "request" | "decision", body: object): Promise<McpOAuthResult<T>> {
  const response = await fetchWithTimeout(`${AUTH_BASE}/api/v2/mcp-oauth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  })
  const parsed = (await response.json().catch(() => null)) as (T & { redirect?: string }) | null
  if (response.ok && parsed) return { ok: true, data: parsed }
  return { ok: false, status: response.status, redirect: parsed?.redirect }
}

/**
 * Leave Aquilla for the requesting app. Its own function so tests can stub it.
 * In the desktop app this opens the system browser (see open-external.ts);
 * the opener only allows http(s), so a custom-scheme redirect (vscode://…)
 * falls back to navigating the window, which bfcache-guard.ts covers.
 */
export function leaveForClient(url: string): void {
  openExternal(url).catch(() => window.location.assign(url))
}

/** Shown after approval for the human to paste back to an agent whose polling
 * gave up. Carries only the (already used) user code and the public endpoint;
 * the agent redeems with the device_code it kept, so no secret crosses chat. */
export function buildApprovedMessage(authBase: string, userCode: string): string {
  const token = `${authBase.replace(/\/+$/, "")}/api/v2/agent-connect/token`
  return `I approved your Aquilla connection request (code ${userCode}). Collect the credential now with one POST to ${token} using client_id "aquilla-agent", grant_type "urn:ietf:params:oauth:grant-type:device_code", and the device_code you kept. Store access_token privately, then GET /me on the Agent API to verify.`
}

/** Safe to paste into any agent chat: no token, user code, or session data. */
export function buildConnectionInstructions(authBase: string, syncOrigin: string): string {
  const connect = `${authBase.replace(/\/+$/, "")}/api/v2/agent-connect`
  const api = `${syncOrigin.replace(/\/+$/, "")}/api/v1/external`
  return `Connect to my Aquilla project using browser authorization.

First fetch ${connect} for the current connection protocol and ${api} for the Agent API and MCP discovery map. Send a descriptive User-Agent header on every request (for example "my-agent/1.0"); some HTTP libraries' default user agents are blocked.

Request access by POSTing JSON to ${connect}/device_authorization:
{"client_id":"aquilla-agent","agent_name":"<your agent name>","scope":"ask"}
If you know the project ID, include project_id. Otherwise I will choose the project in Aquilla. Ask mode allows reading and staging changes; applying changes requires my separate approval.

Keep device_code private in your runtime. Show me verification_uri_complete and user_code so I can open Aquilla, compare the code, and approve access. Open that link in my browser if possible. Never approve the connection or confirm the code on my behalf.

Poll ${connect}/token with client_id "aquilla-agent", grant_type "urn:ietf:params:oauth:grant-type:device_code", and device_code. Wait the returned interval between polls. On authorization_pending continue; on slow_down increase the interval by 5 seconds; stop on access_denied or expired_token. The request expires after 10 minutes. Run the polling loop in the background if your tool calls time out. If polling stops before I approve, keep device_code and wait: after approving I will paste you a message saying so, and one token request will then return the credential.

Store access_token directly in your secure credential store or a local file readable only by its owner. Do not print it, paste it into chat, put it in command arguments, or ask me to configure an environment variable. If you cannot securely store and use credentials, explain that limitation before requesting access. The credential does not expire; it keeps working until I revoke it in Aquilla.

GET ${api}/me with the token as a Bearer header to verify the connection. Then add Aquilla as a persistent remote MCP server (streamable HTTP) named "aquilla" at ${api}/mcp in your own client's user-level config, so every future session can use it without reconnecting. For example: Claude Code's ~/.claude.json mcpServers, Codex's ~/.codex/config.toml [mcp_servers.aquilla], or Hermes's config.yaml mcp_servers. Send the token as an "Authorization: Bearer" header, write it by editing the config file (not with a command-line flag), and keep that file readable only by its owner. Tell me which config file you changed and whether I need to restart you to load it. If your client cannot hold MCP servers, use the discovered Agent API directly instead.

Keep the token out of tool output and logs. In Aquilla's API tokens page I can see when you last used it and revoke it.`
}
