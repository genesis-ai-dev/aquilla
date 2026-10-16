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
import { TOOLS_REVIEW_SYSTEM_PROMPT, buildFixMessage, buildReviewMessage, parseReview, staticUiFindings, type UiCheck } from "./build-review"
import { mergeRequirements, unmetMusts, type ToolRequirement } from "../../../../shared/tools/requirements"

/** The builder model (OpenRouter id). */
export const TOOLS_BUILDER_MODEL = "anthropic/claude-opus-5.5"
/** Output cap per build call — bounds the worst-case spend of one attempt. */
export const TOOLS_BUILDER_MAX_TOKENS = 32_000
/** Repairs after the first attempt. */
export const MAX_REPAIR_ATTEMPTS = 2
/** The self-review replies with a small JSON verdict. */
export const TOOLS_REVIEW_MAX_TOKENS = 6_000

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
  /** Run the self-review + one fix pass after the gates (default true; repairs skip it). */
  review?: boolean
}

/** What the self-review concluded, for the SPA's Try it checklist. */
export interface BuildReviewSummary {
  reviewed: boolean
  ui: UiCheck[]
  /** A fix pass ran (and its result passed the gates). */
  fixed: boolean
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
      requirements: ToolRequirement[]
      review: BuildReviewSummary
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
      requirements: ToolRequirement[]
    }

interface CompletionBody {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  error?: { message?: string }
}

function completionsUrl(env: BuildEnv): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : OPENROUTER_URL
}

type Message = { role: "system" | "user"; content: string }

async function complete(
  env: BuildEnv,
  messages: Message[],
  maxTokens: number,
  fetchImpl: typeof fetch,
): Promise<{ text: string; usage: BuildUsage; model: string; truncated: boolean }> {
  const model = env.TOOLS_BUILDER_MODEL?.trim() || TOOLS_BUILDER_MODEL
  const upstream = builderUpstream(env)
  const res = await fetchImpl(upstream.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstream.apiKey ?? ""}`,
      "X-Title": "Aquilla Tools builder",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, usage: { include: true }, messages }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`builder upstream ${res.status}: ${text.slice(0, 300)}`)
  }
  const body = (await res.json()) as CompletionBody
  if (body.error?.message) throw new Error(`builder upstream error: ${body.error.message}`)
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    truncated: body.choices?.[0]?.finish_reason === "length",
    model,
    usage: {
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      cost: typeof body.usage?.cost === "number" ? body.usage.cost : 0,
    },
  }
}

function addUsage(a: BuildUsage, b: BuildUsage): BuildUsage {
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, cost: a.cost + b.cost }
}

type Gated =
  | { ok: true; source: string; manifest: ToolManifest; manifestJson: string; requirements: ToolRequirement[] }
  | { ok: false; failure: string; source: string | null; manifestJson: string | null; lint: LintIssue[]; requirements: ToolRequirement[] }

/** Parse → manifest → lint, the server-side gates. */
function gate(text: string): Gated {
  const parsed = parseBuildReply(text)
  if ("error" in parsed) return { ok: false, failure: parsed.error, source: null, manifestJson: null, lint: [], requirements: [] }
  const manifestJson = JSON.stringify(parsed.manifest, null, 2)
  const m = validateManifest(parsed.manifest)
  const lint = lintToolSource(parsed.source)
  if (!m.ok || !m.manifest || !lint.ok) {
    const parts: string[] = []
    if (m.errors.length > 0) parts.push(`Manifest errors:\n${m.errors.map((e) => `- ${e}`).join("\n")}`)
    if (!lint.ok) parts.push(`Lint errors:\n${formatLintIssues(lint.issues)}`)
    return { ok: false, failure: parts.join("\n\n"), source: parsed.source, manifestJson, lint: lint.issues, requirements: parsed.requirements }
  }
  return { ok: true, source: parsed.source, manifest: m.manifest, manifestJson, requirements: parsed.requirements }
}

/**
 * One builder attempt. A fresh build (or edit) is: code (with its requirements
 * checklist written first) → gates → self-review against the checklist and the
 * UI bar → at most one fix pass (kept only if it passes the gates). Repairs —
 * the SPA's smoke-render retries — are a single plain call.
 */
export async function runBuild(env: BuildEnv, req: BuildRequest, fetchImpl: typeof fetch = fetch): Promise<BuildResult> {
  const first = await complete(
    env,
    [
      { role: "system", content: TOOLS_BUILDER_SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(req.request, req.repair, req.base) },
    ],
    TOOLS_BUILDER_MAX_TOKENS,
    fetchImpl,
  )
  const model = first.model
  let usage = first.usage
  const g = gate(first.text)
  if (!g.ok) {
    const failure = first.truncated
      ? `Your reply was cut off at the output limit before the tool was complete. Write a much smaller tool: build on the aq SDK components (they are short), no comments, compact CSS, no repeated markup.\n\n${g.failure}`
      : g.failure
    return { ok: false, failure, source: g.source, manifestJson: g.manifestJson, lint: g.lint, model, usage, requirements: g.requirements }
  }

  let best = { source: g.source, manifest: g.manifest, manifestJson: g.manifestJson }
  let requirements = g.requirements
  const summary: BuildReviewSummary = { reviewed: false, ui: [], fixed: false }
  if (req.review === false || req.repair) return { ok: true, ...pick(best), model, usage, requirements, review: summary }

  // Self-review: a failure here never fails the build — the candidate stands unreviewed.
  try {
    const findings = staticUiFindings(best.source, best.manifest)
    const rv = await complete(
      env,
      [
        { role: "system", content: TOOLS_REVIEW_SYSTEM_PROMPT },
        { role: "user", content: buildReviewMessage({ request: req.request, requirements, manifestJson: best.manifestJson, source: best.source, findings }) },
      ],
      TOOLS_REVIEW_MAX_TOKENS,
      fetchImpl,
    )
    usage = addUsage(usage, rv.usage)
    const review = parseReview(rv.text)
    if (review) {
      summary.reviewed = true
      summary.ui = review.ui
      requirements = mergeRequirements(requirements, review.requirements)
      const needsFix = review.fix && (unmetMusts(requirements).length > 0 || review.ui.some((u) => !u.ok))
      if (needsFix && review.fix) {
        const fx = await complete(
          env,
          [
            { role: "system", content: TOOLS_BUILDER_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                buildFixMessage(req.request, review.fix),
                `Current manifest:\n\`\`\`json\n${best.manifestJson}\n\`\`\``,
                `Current source:\n\`\`\`html\n${best.source}\n\`\`\``,
              ].join("\n\n"),
            },
          ],
          TOOLS_BUILDER_MAX_TOKENS,
          fetchImpl,
        )
        usage = addUsage(usage, fx.usage)
        const fg = gate(fx.text)
        if (fg.ok) {
          best = { source: fg.source, manifest: fg.manifest, manifestJson: fg.manifestJson }
          // The fix rewrites the whole checklist (ids may shift): take its rows as written.
          if (fg.requirements.length > 0) requirements = fg.requirements
          summary.fixed = true
        }
      }
    }
  } catch (err) {
    console.warn("[tools/build] review skipped:", err)
  }
  return { ok: true, ...pick(best), model, usage, requirements, review: summary }
}

function pick(b: { source: string; manifest: ToolManifest }): { source: string; manifest: ToolManifest } {
  return { source: b.source, manifest: b.manifest }
}
