import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"

export interface AgentConnectionRequest {
  agentName: string
  mode: "ask" | "act"
  requestedProjectId: string | null
  expiresAt: string
  tokenExpiresIn: number
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

/** Safe to paste into any agent chat: no token, user code, or session data. */
export function buildConnectionInstructions(authBase: string, syncOrigin: string): string {
  const connect = `${authBase.replace(/\/+$/, "")}/api/v2/agent-connect`
  const api = `${syncOrigin.replace(/\/+$/, "")}/api/v1/external`
  return `Connect to my Aquilla project using browser authorization.

First fetch ${connect} for the current connection protocol and ${api} for the Agent API and MCP discovery map.

Request access by POSTing JSON to ${connect}/device_authorization:
{"client_id":"aquilla-agent","agent_name":"<your agent name>","scope":"ask"}
If you know the project ID, include project_id. Otherwise I will choose the project in Aquilla. Ask mode allows reading and staging changes; applying changes requires my separate approval.

Keep device_code private in your runtime. Show me verification_uri_complete and user_code so I can open Aquilla, compare the code, and approve access. Open that link in my browser if possible. Never approve the connection or confirm the code on my behalf.

Poll ${connect}/token with client_id "aquilla-agent", grant_type "urn:ietf:params:oauth:grant-type:device_code", and device_code. Wait the returned interval between polls. On authorization_pending continue; on slow_down increase the interval by 5 seconds; stop on access_denied or expired_token. The request expires after 10 minutes.

Store access_token directly in your secure credential store or a local file readable only by its owner. Do not print it, paste it into chat, put it in command arguments, or ask me to configure an environment variable. If you cannot securely store and use credentials, explain that limitation before requesting access. Credentials expire after 30 days; reconnect when needed.

Use the token as a Bearer header for the discovered API or MCP endpoint. GET ${api}/me to verify the connection and follow the server's discovery map. Keep the token out of tool output and logs. I can revoke access on Aquilla's API tokens page.`
}
