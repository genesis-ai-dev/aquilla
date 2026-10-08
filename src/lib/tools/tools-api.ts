/**
 * Client for the auth-worker Tools API (auth-worker/src/routes/tools.ts).
 */

import { AUTH_API_URL } from "@/lib/sync/sync-token"
import type { ToolManifest, ToolScope } from "../../../shared/tools/manifest"
import type { LintIssue } from "../../../shared/tools/lint"
import type { ToolWrite, TouchedCellState } from "../../../shared/tools/revert"

export type ToolVersionOrigin = "starter" | "builder" | "edit" | "copy"

export interface ToolSummary {
  id: string
  projectId: string
  name: string
  description: string
  currentVersion: number
  upstreamToolId: string | null
  createdBy: number
  createdAt: string
  updatedAt: string
  codeHash: string
  apiRev: number
  manifest: ToolManifest
  origin: ToolVersionOrigin
  grantedScopes: ToolScope[]
}

export interface ToolDetail extends ToolSummary {
  source: string
}

export interface ToolVersion {
  version: number
  codeHash: string
  apiRev: number
  origin: ToolVersionOrigin
  manifest: ToolManifest
  buildMeta: Record<string, unknown> | null
  createdBy: number
  createdAt: string
}

export interface ToolActivityEvent {
  id: string
  kind: string
  fileId: string | null
  cellId: string | null
  author: string
  serverTs: number
  version: number | null
  verified: boolean
  value: string | null
  ref: string | null
}

export interface ToolActivity {
  events: ToolActivityEvent[]
  writes: ToolWrite[]
  cells: TouchedCellState[]
  truncated: boolean
}

export interface BuildUsage {
  promptTokens: number
  completionTokens: number
  cost: number
}

export type BuildAttempt =
  | { ok: true; source: string; manifest: ToolManifest; model: string; usage: BuildUsage }
  | {
      ok: false
      failure: string
      source: string | null
      manifestJson: string | null
      lint: LintIssue[]
      model: string
      usage: BuildUsage
    }

export class ToolsApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = "ToolsApiError"
  }
}

async function request<T>(jwt: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${AUTH_API_URL}/api/v2/projects${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    throw new ToolsApiError(res.status, body?.error?.code ?? "error", body?.error?.message ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

const p = (projectId: string) => `/${encodeURIComponent(projectId)}/tools`

export async function listTools(jwt: string, projectId: string): Promise<ToolSummary[]> {
  return (await request<{ tools: ToolSummary[] }>(jwt, p(projectId))).tools
}

export async function getTool(jwt: string, projectId: string, toolId: string): Promise<ToolDetail> {
  return (await request<{ tool: ToolDetail }>(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}`)).tool
}

export async function listToolVersions(jwt: string, projectId: string, toolId: string): Promise<ToolVersion[]> {
  return (await request<{ versions: ToolVersion[] }>(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}/versions`)).versions
}

export interface SaveToolInput {
  source: string
  manifest: ToolManifest
  origin: ToolVersionOrigin
  buildMeta?: Record<string, unknown>
  grant?: ToolScope[]
  upstreamToolId?: string
}

export async function installTool(jwt: string, projectId: string, input: SaveToolInput): Promise<ToolDetail> {
  return (await request<{ tool: ToolDetail }>(jwt, p(projectId), { method: "POST", body: input })).tool
}

export async function saveToolVersion(
  jwt: string,
  projectId: string,
  toolId: string,
  input: SaveToolInput,
): Promise<ToolDetail> {
  return (
    await request<{ tool: ToolDetail }>(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}/versions`, {
      method: "POST",
      body: input,
    })
  ).tool
}

export async function setToolGrant(jwt: string, projectId: string, toolId: string, scopes: ToolScope[]): Promise<ToolScope[]> {
  return (
    await request<{ scopes: ToolScope[] }>(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}/grant`, {
      method: "PUT",
      body: { scopes },
    })
  ).scopes
}

export async function removeTool(jwt: string, projectId: string, toolId: string): Promise<void> {
  await request<{ ok: true }>(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}`, { method: "DELETE" })
}

export async function copyTool(jwt: string, projectId: string, toolId: string, targetProjectId: string): Promise<ToolDetail> {
  return (
    await request<{ tool: ToolDetail }>(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}/copy`, {
      method: "POST",
      body: { targetProjectId },
    })
  ).tool
}

export async function fetchToolSource(
  jwt: string,
  projectId: string,
  toolId: string,
  version = 0,
): Promise<{ version: number; source: string; codeHash: string; upstreamToolId: string | null }> {
  return request(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}/source?version=${version}`)
}

export async function fetchToolActivity(jwt: string, projectId: string, toolId: string, sinceMs: number): Promise<ToolActivity> {
  return request<ToolActivity>(jwt, `${p(projectId)}/${encodeURIComponent(toolId)}/activity?since=${Math.max(0, Math.floor(sinceMs))}`)
}

export async function buildToolAttempt(
  jwt: string,
  projectId: string,
  body: {
    request: string
    attempt: number
    repair?: { previousSource: string; previousManifest: string; failure: string }
    /** edit_tool: the version being changed. */
    base?: { source: string; manifest: string }
  },
): Promise<BuildAttempt> {
  return request<BuildAttempt>(jwt, `${p(projectId)}/build`, { method: "POST", body })
}
