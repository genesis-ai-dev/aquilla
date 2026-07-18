// Remote MCP server for the Aquilla Agent API (AQU-533 §4).
//
//   POST /api/v1/external/mcp  — JSON-RPC 2.0 over MCP streamable-HTTP.
//   GET  /api/v1/external/mcp  — 405 (this server is tools-only, no SSE stream).
//
// Hand-rolled (no npm MCP SDK, no Durable Object). STATELESS: there is no session
// store — every request re-authenticates the `aqk_` bearer credential via
// validateApiCredential, exactly like the REST external surface. A missing or
// invalid credential is an HTTP 401 with the errors.ts envelope (not a JSON-RPC
// error), so transports fail fast before any method runs.
//
// Methods: initialize, notifications/initialized (202), ping, tools/list,
// tools/call. Unknown method -> JSON-RPC -32601. The tool layer (mcp-handlers.ts)
// returns tool results whose errors carry the same stable codes as REST.

import { externalError } from './errors'
import { MCP_TOOLS } from './mcp-tools'
import { callTool, UNKNOWN_TOOL } from './mcp-handlers'
import type { ExternalEnv } from './types'
import { validateApiCredential } from '../../../db/shared/api-credentials'

const MCP_PATH = '/api/v1/external/mcp'

/** Protocol versions this server recognizes; an initialize echoes the client's
 *  when known, else pins the latest we implement. */
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
}

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } })
}

export async function handleExternalMcpRequest(
  request: Request,
  env: ExternalEnv,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== MCP_PATH) return null

  if (request.method !== 'POST') {
    return new Response('method not allowed — POST JSON-RPC only', {
      status: 405,
      headers: { Allow: 'POST' },
    })
  }

  if (!env.AQUILLA_PG) return externalError('job_failed', 'AQUILLA_PG not configured', 500)

  // Stateless auth: re-validate the credential on every request.
  const token = bearer(request)
  if (!token) return externalError('permission_denied', 'missing Authorization header', 401)
  const cred = await validateApiCredential(env.AQUILLA_PG, token)
  if (!cred) {
    return externalError('permission_denied', 'invalid, revoked, or expired API credential', 401)
  }

  let message: JsonRpcRequest
  try {
    const parsed = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return rpcError(null, -32600, 'invalid request: expected a single JSON-RPC object')
    }
    message = parsed as JsonRpcRequest
  } catch {
    return rpcError(null, -32700, 'parse error: invalid JSON')
  }

  const { method } = message
  const id: JsonRpcId = message.id ?? null

  // Notifications (no response body, ack with 202).
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
    return new Response(null, { status: 202 })
  }

  switch (method) {
    case 'initialize': {
      const params = (message.params ?? {}) as { protocolVersion?: unknown }
      const clientVersion =
        typeof params.protocolVersion === 'string' && KNOWN_PROTOCOL_VERSIONS.has(params.protocolVersion)
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION
      return rpcResult(id, {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'aquilla', version: '0.1.0' },
      })
    }

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS })

    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
      if (typeof params.name !== 'string') {
        return rpcError(id, -32602, 'invalid params: tools/call requires a string "name"')
      }
      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {}
      const result = await callTool(params.name, args, env, cred, token, ctx)
      if (result === UNKNOWN_TOOL) {
        return rpcError(id, -32602, `unknown tool: ${params.name}`)
      }
      return rpcResult(id, result)
    }

    default:
      return rpcError(id, -32601, `method not found: ${String(method)}`)
  }
}
