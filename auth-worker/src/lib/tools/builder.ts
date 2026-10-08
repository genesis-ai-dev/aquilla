// Aquilla Tools builder — one model call per request.
//
// The repair loop is driven by the caller (the SPA), because the last gate —
// the smoke render — runs client-side in a sandboxed iframe: generated code is
// NEVER executed in this worker, next to its secrets. This module produces a
// candidate and runs the server-side gates (parse, manifest validation, lint);
// the SPA runs the smoke render and, on any failure, calls back with the error
// for up to MAX_REPAIR_ATTEMPTS repairs.

import { validateManifest, type ToolManifest } from "../../../../shared/tools/manifest"
import { formatLintIssues, lintToolSource, type LintIssue } from "../../../../shared/tools/lint"
import { TOOLS_BUILDER_SYSTEM_PROMPT, buildUserMessage, parseBuildReply } from "./build-prompt"

/** The builder model (OpenRouter id). */
export const TOOLS_BUILDER_MODEL = "anthropic/claude-opus-5.5"
/** Output cap per build call — bounds the worst-case spend of one attempt. */
export const TOOLS_BUILDER_MAX_TOKENS = 16_000
/** Repairs after the first attempt. */
export const MAX_REPAIR_ATTEMPTS = 2

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

export interface BuildEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  TOOLS_BUILDER_API_KEY?: string
  TOOLS_BUILDER_BASE_URL?: string
  TOOLS_BUILDER_MODEL?: string
}

/** The key + endpoint the builder uses: a dedicated TOOLS_BUILDER_* pair when
 *  configured, otherwise the shared chat/agent OpenRouter settings. */
export function builderUpstream(env: BuildEnv): { apiKey: string | null; url: string } {
  const dedicated = env.TOOLS_BUILDER_API_KEY?.trim()
  if (dedicated) {
    const base = env.TOOLS_BUILDER_BASE_URL?.trim()
    return { apiKey: dedicated, url: base ? `${base.replace(/\/$/, "")}/chat/completions` : OPENROUTER_URL }
  }
  return { apiKey: env.OPENROUTER_API_KEY?.trim() || null, url: completionsUrl(env) }
}

export interface BuildRequest {
  request: string
  repair?: { previousSource: string; previousManifest: string; failure: string }
  /** edit_tool: the version being changed. Absent = build_tool (new tool). */
  base?: { source: string; manifest: string }
}

export interface BuildUsage {
  promptTokens: number
  completionTokens: number
  /** USD as OpenRouter reports it (usage.include). */
  cost: number
}

export type BuildResult =
  | {
      ok: true
      source: string
      manifest: ToolManifest
      model: string
      usage: BuildUsage
    }
  | {
      ok: false
      /** Feed back to the model on the next attempt. */
      failure: string
      source: string | null
      manifestJson: string | null
      lint: LintIssue[]
      model: string
      usage: BuildUsage
    }

interface CompletionBody {
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  error?: { message?: string }
}

function completionsUrl(env: BuildEnv): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : OPENROUTER_URL
}

export async function runBuild(env: BuildEnv, req: BuildRequest, fetchImpl: typeof fetch = fetch): Promise<BuildResult> {
  const model = env.TOOLS_BUILDER_MODEL?.trim() || TOOLS_BUILDER_MODEL
  const upstream = builderUpstream(env)
  const res = await fetchImpl(upstream.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstream.apiKey ?? ""}`,
      "X-Title": "Aquilla Tools builder",
    },
    body: JSON.stringify({
      model,
      max_tokens: TOOLS_BUILDER_MAX_TOKENS,
      temperature: 0.2,
      usage: { include: true },
      messages: [
        { role: "system", content: TOOLS_BUILDER_SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(req.request, req.repair, req.base) },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`builder upstream ${res.status}: ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as CompletionBody
  if (body.error?.message) throw new Error(`builder upstream error: ${body.error.message}`)
  const usage: BuildUsage = {
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
    cost: typeof body.usage?.cost === "number" ? body.usage.cost : 0,
  }
  const text = body.choices?.[0]?.message?.content ?? ""
  const parsed = parseBuildReply(text)
  if ("error" in parsed) {
    return { ok: false, failure: parsed.error, source: null, manifestJson: null, lint: [], model, usage }
  }
  const manifestJson = JSON.stringify(parsed.manifest, null, 2)
  const m = validateManifest(parsed.manifest)
  const lint = lintToolSource(parsed.source)
  if (!m.ok || !m.manifest || !lint.ok) {
    const parts: string[] = []
    if (m.errors.length > 0) parts.push(`Manifest errors:\n${m.errors.map((e) => `- ${e}`).join("\n")}`)
    if (!lint.ok) parts.push(`Lint errors:\n${formatLintIssues(lint.issues)}`)
    return { ok: false, failure: parts.join("\n\n"), source: parsed.source, manifestJson, lint: lint.issues, model, usage }
  }
  return { ok: true, source: parsed.source, manifest: m.manifest, model, usage }
}
