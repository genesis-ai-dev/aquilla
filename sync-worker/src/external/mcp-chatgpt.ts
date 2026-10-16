// AQU-1584: OAuth adapters delegate to the existing command engine.
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { callTool, UNKNOWN_TOOL, type McpToolResult } from './mcp-handlers'
import { CHATGPT_TOOLS, CHATGPT_OPERATIONS, CHATGPT_COMMAND_KINDS,
  CHATGPT_INSTRUCTIONS, type ObjectSchema } from './mcp-chatgpt-tools'
import { loadChangeset } from './store'
import type { Command } from './commands'
import type { ExternalEnv } from './types'

function result(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError } : {}) }
}
function invalid(message: string): McpToolResult {
  return result({ error: { code: 'validation_failed', message } }, true)
}
function validObject(value: unknown, schema: ObjectSchema): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.every(k => Object.hasOwn(schema.properties, k)) &&
    (schema.required ?? []).every(k => k in value)
}

/** The engine normalizes HideCell/ShowCell into visibility events. These are
 * the same reviewed operations, not permission to commit arbitrary events. */
function isReviewedCommand(command: Command): boolean {
  if (CHATGPT_COMMAND_KINDS.has(command.kind)) return true
  return command.kind === 'EmitEvents' && command.events.length > 0 &&
    command.events.every(event => event.kind === 'source.cell.visibility.set')
}

export async function callChatGptTool(
  name: string, args: Record<string, unknown>, env: ExternalEnv,
  cred: ApiCredentialContext, token: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<McpToolResult | typeof UNKNOWN_TOOL> {
  const tool = CHATGPT_TOOLS.find(t => t.name === name)
  if (!tool) return UNKNOWN_TOOL
  // Reject generic executor arguments even when a client bypasses its schema.
  if (!validObject(args, tool.inputSchema)) return invalid('arguments must match the declared tool schema')
  if (name === 'get_capabilities') {
    const legacy = await callTool(name, {}, env, cred, token, ctx) as McpToolResult
    const capabilities = JSON.parse(legacy.content[0].text) as Record<string, unknown>
    return result({
      apiVersion: capabilities.apiVersion, credentialMode: cred.mode, credentialAccess: cred.access,
      orgIds: cred.orgIds, limits: capabilities.limits, errorCodes: capabilities.errorCodes,
      operations: CHATGPT_TOOLS.map(t => t.name),
      quickstart: CHATGPT_INSTRUCTIONS,
      humanValidation: 'Saving does not establish human translation validation.',
    })
  }
  if (name === 'get_skill') {
    if (args.name !== undefined && args.name !== 'translation-workflow') {
      return invalid('only the translation-workflow cookbook is available on this connection')
    }
    return result({ name: 'translation-workflow', markdown: CHATGPT_INSTRUCTIONS })
  }
  const operation = CHATGPT_OPERATIONS.get(name)
  if (operation) {
    if (!Array.isArray(args.updates) || args.updates.length === 0 ||
      !args.updates.every(u => validObject(u, operation.schema))) {
      return invalid('updates must contain only the declared operation fields')
    }
    return callTool('prepare_translations', {
      projectId: args.projectId, changesetId: args.changesetId,
      commands: args.updates.map(u => ({ ...u, kind: operation.kind })),
    }, env, cred, token, ctx)
  }
  if (name === 'prepare_translations') {
    const schema = (tool.inputSchema.properties.translations as { items: ObjectSchema }).items
    if (!Array.isArray(args.translations) || args.translations.length === 0 ||
      !args.translations.every(u => validObject(u, schema))) {
      return invalid('translations must contain only target translation fields')
    }
  }
  if (name === 'confirm_changeset' && env.AQUILLA_PG &&
    typeof args.projectId === 'string' && typeof args.changesetId === 'string') {
    const changeset = await loadChangeset(env.AQUILLA_PG, args.projectId, args.changesetId)
    // Do not disclose or inspect another credential's plan before authorization.
    if (changeset?.credentialId === cred.credentialId &&
      changeset.commands.some(command => !isReviewedCommand(command))) {
      return invalid('this changeset contains an operation unavailable on this connection')
    }
  }
  return callTool(name, args, env, cred, token, ctx)
}
