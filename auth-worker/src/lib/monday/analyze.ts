// AI board-analysis — one non-streaming OpenRouter call (same internals as
// routes/chat.ts: direct fetch with env.OPENROUTER_API_KEY, JSON mode) that
// proposes a MondayMapping for a board + project. The LLM output is NEVER
// trusted: sanitizeMapping clamps it server-side (unknown columnIds dropped,
// read-only column types rejected) before it reaches the client.

import type { Env } from "../../types"
import { getPlatformSettingsCached } from "../platform-settings"
import { openRouterUsage } from "../llm-vendor"
import { DEFAULT_LLM_MODEL_ID } from "../model-defaults"
import {
  sanitizeMapping,
  METRIC_KEYS,
  WRITABLE_TYPES_BY_METRIC,
  type MondayBoardColumn,
  type MondayBoardGroup,
  type MondayMapping,
} from "./types"
import type { MondayItemSample } from "./client"
import type { ProjectMetricsSummary } from "./metrics"

export interface AnalyzeArgs {
  structure: { columns: MondayBoardColumn[]; groups: MondayBoardGroup[] }
  sampleItems: MondayItemSample[]
  summary: ProjectMetricsSummary
  currentConfig?: MondayMapping
  message?: string
}

export interface AnalyzeResult {
  proposal: MondayMapping
  summary: string
  warnings: string[]
}

function metricConstraintLines(): string {
  return METRIC_KEYS.map(
    (key) => `  - ${key}: writable column types = ${WRITABLE_TYPES_BY_METRIC[key].join(", ")}`,
  ).join("\n")
}

function buildPrompt(args: AnalyzeArgs): string {
  const { structure, sampleItems, summary } = args
  const lines: string[] = [
    "You are configuring a Monday.com board integration for an Aquilla translation project.",
    // "column mapping" is load-bearing: the dev-stack OpenRouter mock
    // (scripts/mock-openrouter.ts) routes on this phrase.
    "Propose a column mapping from Aquilla progress metrics to Monday board columns.",
    "",
    "Available metrics and their writable Monday column types:",
    metricConstraintLines(),
    "",
    "Rules:",
    "- STRONGLY prefer mapping to EXISTING suitable columns before proposing anything else.",
    "- NEVER map to read-only column types (formula, mirror, progress, auto_number, button, etc.).",
    "- itemGranularity 'project' = one board item for the whole project; 'file' = one item per file.",
    "- Map an 'external_id' text column when one exists (used for idempotent re-linking).",
    "- Set notes to a short human rationale.",
    "",
    `Project: ${summary.projectName} (${summary.projectId})`,
    `Files (${summary.files.length}): ${summary.files.map((f) => f.fileName).join(", ") || "(none yet)"}`,
    `Project metrics now: ${JSON.stringify(summary.project)}`,
    "",
    `Board columns: ${JSON.stringify(structure.columns.map((c) => ({ id: c.id, title: c.title, type: c.type })))}`,
    `Board groups: ${JSON.stringify(structure.groups)}`,
    `Sample items (first ${sampleItems.length}): ${JSON.stringify(
      sampleItems.slice(0, 25).map((i) => ({ id: i.id, name: i.name })),
    )}`,
  ]
  if (args.currentConfig) {
    lines.push(
      "",
      "The user already has a mapping and wants to CHANGE it. Merge their request into the existing config, keeping everything they did not ask to change:",
      `Current config: ${JSON.stringify(args.currentConfig)}`,
    )
  }
  if (args.message) {
    lines.push("", `User request: ${args.message}`)
  }
  lines.push(
    "",
    'Respond with STRICT JSON: {"mapping": {"version": 1, "itemGranularity": "project"|"file", "groupId"?: string, "itemNameTemplate"?: string, "matchExisting"?: {"columnId": string} | {"byName": true}, "columns": [{"columnId": string, "columnType": string, "metric": string}], "notes": string}, "summary": string}',
    "summary = one or two sentences for the user describing what the mapping does.",
  )
  return lines.join("\n")
}

/** Thrown when the AI upstream itself is unavailable (non-2xx) — the route
 *  turns this into a clean 502, never a misleading "invalid JSON". */
export class AnalyzeUpstreamError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`AI provider unavailable (HTTP ${status})`)
    this.name = "AnalyzeUpstreamError"
    this.status = status
  }
}

/**
 * Extract the first balanced JSON object from possibly-messy LLM output:
 * strips markdown code fences, then brace-scans (string-aware) so leading or
 * trailing prose around the object doesn't break parsing.
 */
export function extractJsonObject(content: string): string | null {
  let text = content.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function tryParseProposal(content: string): { mapping?: unknown; summary?: unknown } | null {
  const json = extractJsonObject(content)
  if (!json) return null
  try {
    return JSON.parse(json) as { mapping?: unknown; summary?: unknown }
  } catch {
    return null
  }
}

async function callLlm(env: Env, model: string, prompt: string): Promise<string> {
  const base = env.OPENROUTER_BASE_URL
    ? env.OPENROUTER_BASE_URL.replace(/\/$/, "")
    : "https://openrouter.ai/api/v1"
  const upstream = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      ...openRouterUsage(env.OPENROUTER_BASE_URL),
    }),
  })
  if (!upstream.ok) {
    // Log the body snippet server-side only — never surfaced to the client.
    const text = await upstream.text().catch(() => "")
    console.error(`[monday analyze] upstream HTTP ${upstream.status}: ${text.slice(0, 300)}`)
    throw new AnalyzeUpstreamError(upstream.status)
  }
  const data = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error("LLM returned no content")
  return content
}

/** Run the LLM analysis and clamp its proposal. Throws on upstream/parse failure. */
export async function analyzeBoardMapping(env: Env, args: AnalyzeArgs): Promise<AnalyzeResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }
  const settings = await getPlatformSettingsCached(env)
  const model =
    settings.defaultLlmModel || env.DEFAULT_LLM_MODEL || DEFAULT_LLM_MODEL_ID

  const prompt = buildPrompt(args)
  let parsed = tryParseProposal(await callLlm(env, model, prompt))
  if (!parsed) {
    // One retry with an explicit JSON-only instruction before giving up.
    parsed = tryParseProposal(
      await callLlm(env, model, `${prompt}\n\nReturn ONLY the JSON object.`),
    )
  }
  if (!parsed) throw new Error("LLM returned invalid JSON")

  const { mapping, warnings } = sanitizeMapping(parsed.mapping, args.structure)
  if (!mapping) throw new Error("LLM proposal was not a usable mapping")

  return {
    proposal: mapping,
    summary:
      typeof parsed.summary === "string" && parsed.summary
        ? parsed.summary
        : (mapping.notes ?? "Proposed a mapping based on the board structure."),
    warnings,
  }
}
