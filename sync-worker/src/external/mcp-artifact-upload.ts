import { handleExternalArtifactsRequest } from './artifacts-route'
import type { ExternalEnv } from './types'
import type { McpToolResult } from './mcp-handlers'

export const MCP_ARTIFACT_MAX_BYTES = 512 * 1024

function result(payload: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  }
}

export async function uploadArtifact(
  env: ExternalEnv, token: string, args: Record<string, unknown>,
): Promise<McpToolResult> {
  const invalid = (message: string) => result({ error: { code: 'validation_failed', message } }, true)
  for (const key of ['projectId', 'name', 'contentType', 'data']) {
    if (typeof args[key] !== 'string' || args[key].length === 0) return invalid(`${key} is required`)
  }
  const { projectId, name, contentType, data } = args as Record<string, string>
  if (args.kind !== 'source' && args.kind !== 'audio') return invalid('kind must be source or audio')
  if (args.encoding !== 'utf8' && args.encoding !== 'base64') return invalid('encoding must be utf8 or base64')
  // Bound before decoding; base64 expands bytes by at most 4/3.
  if (data.length > 4 * Math.ceil(MCP_ARTIFACT_MAX_BYTES / 3)) return invalid('artifact exceeds the 524288-byte MCP limit')
  let bytes: Uint8Array
  if (args.encoding === 'utf8') {
    bytes = new TextEncoder().encode(data)
  } else {
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      return invalid('data must be canonical base64 without a data URL')
    }
    const decoded = atob(data)
    if (btoa(decoded) !== data) return invalid('data must be canonical base64')
    bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
  }
  if (bytes.byteLength > MCP_ARTIFACT_MAX_BYTES) return invalid('artifact exceeds the 524288-byte MCP limit')
  let headers: Headers
  try {
    headers = new Headers({
      Authorization: `Bearer ${token}`,
      'content-type': contentType,
      'x-artifact-name': name,
      'x-artifact-kind': args.kind,
    })
  } catch {
    return invalid('name and contentType must be valid HTTP header values')
  }
  // Only this in-process delegation carries the MCP resource audience. External
  // REST requests still reject MCP-bound credentials, including forged headers.
  const request = (env.mcpRequest ?? ((input, init) => new Request(input, init)))(
    `https://internal/api/v1/external/projects/${encodeURIComponent(projectId)}/artifacts`,
    { method: 'POST', headers, body: bytes },
  )
  const response = await handleExternalArtifactsRequest(request, env)
  if (!response) return result({ error: { code: 'not_found', message: 'artifact route did not match' } }, true)
  return result(await response.json(), !response.ok)
}
