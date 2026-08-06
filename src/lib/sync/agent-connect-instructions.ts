// Builds the copy-paste "connect your AI agent" block shown once, right after a
// personal API token is minted (AQU-811). A non-technical user hands their agent
// (Claude Cowork, OpenAI Codex, any MCP client) these instructions and it can
// drive their Aquilla projects with their permissions.
//
// The block embeds the *real* plaintext token, so it is only ever produced at
// mint time (ShowOnceTokenDialog) — never with a blank/placeholder token. The
// endpoints mirror docs/api/QUICKSTART.md: one token authenticates everything on
// the sync host, the external API base is `<origin>/api/v1/external`, and the MCP
// endpoint is that base + `/mcp`.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { MintCredentialResult } from "./credentials"

/** The external Agent API base URL, e.g. `https://api.aquilla.app/sync/api/v1/external`. */
export function externalApiBase(): string {
  return `${syncWorkerHttpOrigin()}/api/v1/external`
}

/**
 * Compose a self-contained instruction block a user can paste into an external
 * AI agent to give it access to their Aquilla projects via the just-minted token.
 *
 * Pure and deterministic given its inputs so it can be unit-tested; the caller
 * supplies the API base (defaults to the built origin) and the scope label it
 * already resolved for display.
 */
export function buildAgentConnectInstructions({
  result,
  scope,
  apiBase = externalApiBase(),
}: {
  result: MintCredentialResult
  /** Friendly scope label already resolved by the caller, e.g. "Acme Org". */
  scope: string
  apiBase?: string
}): string {
  const token = result.token
  const mcpUrl = `${apiBase}/mcp`
  const mode = result.credential.mode
  const modeLine =
    mode === "act"
      ? 'This token is in "act" mode: staged writes are committed immediately.'
      : 'This token is in "ask" mode: every write is staged and waits for me to approve it in my browser before it applies — surface the approval link and wait, never try to skip it.'

  return [
    "Please connect to my Aquilla translation workspace and work in it on my behalf.",
    "",
    "Aquilla exposes an agent API (REST + MCP). Authenticate with this personal token — it carries my permissions and scope, re-checked on every call:",
    "",
    `  Token:        ${token}`,
    `  Scope:        ${scope}`,
    `  API base:     ${apiBase}`,
    `  MCP endpoint: ${mcpUrl}`,
    "",
    "To connect as an MCP server (recommended), run:",
    `  claude mcp add aquilla --transport http "${mcpUrl}" --header "Authorization: Bearer ${token}"`,
    "",
    `Or call the REST API directly with the header:  Authorization: Bearer ${token}`,
    "",
    "First steps:",
    `  1. GET ${apiBase}            → the API describes itself (no auth needed).`,
    `  2. GET ${apiBase}/me         → confirm my scope and autonomy mode.`,
    `  3. GET ${apiBase}/projects   → list the projects I can access.`,
    "",
    "What you can do: read my projects, files, and cells; search across translations; and stage translation edits, file imports, and new projects. Every write is staged as a changeset first, then committed.",
    modeLine,
  ].join("\n")
}
