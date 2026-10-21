// "Set up with AI" for Airtable (AQU-804) — Monday's board analysis
// (lib/monday/analyze.ts) for a table: the model looks at the table's existing
// fields and a sample of its records and proposes which Aquilla number goes in
// which field, and whether the table wants one record for the project, one
// per file (episode), or both. Its answer is NEVER trusted:
// sanitizeAirtableMapping clamps it before it reaches the client.
//
// Picking the table is a separate, cheap call over table names only, made
// only when there is a real choice.

import type { Env } from "../../types"
import { getPlatformSettingsCached } from "../platform-settings"
import { DEFAULT_LLM_MODEL_ID } from "../model-defaults"
import { callAnalysisLlm, parseJsonAnswer } from "../integrations/llm"
import type { ProjectMetricsSummary } from "../monday/metrics"
import { METRIC_KEYS } from "../monday/types"
import type { AirtableRecord } from "./client"
import {
  sanitizeAirtableMapping,
  WRITABLE_FIELD_TYPES_BY_METRIC,
  type AirtableMapping,
  type AirtableTableStructure,
} from "./types"

export interface AirtableAnalyzeArgs {
  structure: AirtableTableStructure
  sampleRecords: AirtableRecord[]
  summary: ProjectMetricsSummary
  currentConfig?: AirtableMapping
  message?: string
}

export interface AirtableAnalyzeResult {
  proposal: AirtableMapping
  summary: string
  warnings: string[]
}

async function analysisModel(env: Env): Promise<string> {
  const settings = await getPlatformSettingsCached(env)
  return settings.defaultLlmModel || env.DEFAULT_LLM_MODEL || DEFAULT_LLM_MODEL_ID
}

function buildPrompt(args: AirtableAnalyzeArgs): string {
  const { structure, sampleRecords, summary } = args
  const primary = structure.primaryFieldId
  const lines: string[] = [
    "You are configuring an Airtable table integration for an Aquilla translation project.",
    // "Airtable field mapping" is load-bearing: the dev-stack OpenRouter mock
    // (scripts/mock-openrouter.ts) routes on this phrase.
    "Propose an Airtable field mapping from Aquilla progress metrics to the table's fields.",
    "",
    "Available metrics and the Airtable field types each can write:",
    METRIC_KEYS.map((key) => `  - ${key}: ${WRITABLE_FIELD_TYPES_BY_METRIC[key].join(", ")}`).join("\n"),
    "",
    "Rules:",
    "- STRONGLY prefer mapping to EXISTING suitable fields; never invent field ids.",
    "- NEVER map to computed fields (formula, rollup, lookup, count, autoNumber, created/modified time).",
    "- Percentages suit percent or number fields; 'status_auto' and 'schedule_status' suit single-select fields like Status or Schedule; dates suit date fields; 'project_link' a URL field.",
    "- 'deadline' is the project's due date; 'has_audio_pct' is the share of lines with a recording, not how many recordings are approved ('audio_validated_pct').",
    "- Map an 'external_id' text field (e.g. 'Aquilla ID') when one exists; it identifies Aquilla's records.",
    "- itemGranularity: 'project' = one record for the whole project; 'file' = one record per file (an episode, book or chapter); 'project_and_files' = both, in this table. Choose from the sample records: names that look like episodes or chapters mean 'file', names that look like projects or languages mean 'project'. When the table is empty or holds both, choose 'project_and_files'.",
    "- itemNameTemplate (optional) names each record through the primary field: '{projectName}' and '{fileName}' are filled in. Match the naming the sample records already use.",
    "- Set notes to a short human rationale.",
    "",
    `Project: ${summary.projectName} (${summary.projectId})`,
    `Files (${summary.files.length}): ${summary.files.map((f) => f.fileName).join(", ") || "(none yet)"}`,
    `Project metrics now: ${JSON.stringify(summary.project)}`,
    "",
    `Table: ${structure.tableName ?? structure.tableId} (${structure.tableId})`,
    `Primary field: ${primary ?? "(unknown)"}`,
    `Table fields: ${JSON.stringify(structure.fields.map((f) => ({ id: f.id, name: f.name, type: f.type })))}`,
    `Sample records (first ${sampleRecords.length}): ${JSON.stringify(
      sampleRecords.slice(0, 25).map((r) => ({ id: r.id, name: primary ? (r.fields[primary] ?? null) : null })),
    )}`,
  ]
  if (args.currentConfig) {
    lines.push(
      "",
      "The user already has a mapping and wants to CHANGE it. Merge their request into the existing config, keeping everything they did not ask to change:",
      `Current config: ${JSON.stringify(args.currentConfig)}`,
    )
  }
  if (args.message) lines.push("", `User request: ${args.message}`)
  lines.push(
    "",
    'Respond with STRICT JSON: {"mapping": {"version": 1, "tableId": string, "itemGranularity": "project"|"file"|"project_and_files", "itemNameTemplate"?: string, "matchExisting"?: {"columnId": string} | {"byName": true}, "columns": [{"columnId": "<field id>", "columnType": "<field type>", "metric": string}], "notes": string}, "summary": string}',
    "summary = one or two sentences for the user describing what the mapping does.",
  )
  return lines.join("\n")
}

/** Run the analysis and clamp its proposal. Throws on upstream/parse failure. */
export async function analyzeTableMapping(env: Env, args: AirtableAnalyzeArgs): Promise<AirtableAnalyzeResult> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured")
  const model = await analysisModel(env)
  const prompt = buildPrompt(args)
  type Answer = { mapping: unknown; summary: unknown }
  let parsed = parseJsonAnswer<Answer>(await callAnalysisLlm(env, model, prompt, "airtable analyze"))
  if (!parsed) {
    parsed = parseJsonAnswer<Answer>(
      await callAnalysisLlm(env, model, `${prompt}\n\nReturn ONLY the JSON object.`, "airtable analyze"),
    )
  }
  if (!parsed) throw new Error("LLM returned invalid JSON")

  // The table is the one we read, whatever the model wrote.
  const rawMapping =
    parsed.mapping && typeof parsed.mapping === "object" && !Array.isArray(parsed.mapping)
      ? { ...(parsed.mapping as Record<string, unknown>), tableId: args.structure.tableId }
      : parsed.mapping
  const { mapping, warnings } = sanitizeAirtableMapping(rawMapping, args.structure)
  if (!mapping) throw new Error("LLM proposal was not a usable mapping")
  return {
    proposal: mapping,
    summary:
      typeof parsed.summary === "string" && parsed.summary
        ? parsed.summary
        : (mapping.notes ?? "Proposed a mapping based on the table's fields."),
    warnings,
  }
}

// ── Table selection ─────────────────────────────────────────────────────────

export interface TableCandidate {
  baseId: string
  baseName: string
  tableId: string
  tableName: string
}

export interface TableChoice extends TableCandidate {
  /** One short sentence for the user; empty when chosen without an LLM call. */
  reason: string
}

/** The token can see no tables: the user's to fix (grant the token a base), not an outage. */
export class NoTablesError extends Error {
  constructor() {
    super("no tables found for this Airtable token")
    this.name = "NoTablesError"
  }
}

function scoreTable(table: TableCandidate, summary: ProjectMetricsSummary): number {
  const tokenize = (s: string) => s.toLowerCase().split(/[\s\p{P}]+/u).filter((t) => t.length > 2)
  const needle = new Set([...tokenize(summary.projectName), ...summary.files.flatMap((f) => tokenize(f.fileName))])
  if (needle.size === 0) return 0
  return [...tokenize(table.baseName), ...tokenize(table.tableName)].filter((t) => needle.has(t)).length
}

function bestByName(tables: TableCandidate[], summary: ProjectMetricsSummary): TableCandidate {
  let best = tables[0]!
  let bestScore = scoreTable(best, summary)
  for (const t of tables.slice(1)) {
    const score = scoreTable(t, summary)
    if (score > bestScore) {
      best = t
      bestScore = score
    }
  }
  return best
}

/**
 * Pick the table this project's progress should go to. Zero tables is an
 * error, one needs no model. Only a genuine choice reaches the model, and its
 * answer is checked against the real list — an id it made up falls back to
 * the best name match.
 */
export async function selectTableForProject(
  env: Env,
  args: { tables: TableCandidate[]; summary: ProjectMetricsSummary },
): Promise<TableChoice> {
  const { tables, summary } = args
  if (tables.length === 0) throw new NoTablesError()
  if (tables.length === 1) return { ...tables[0]!, reason: "" }

  const prompt = [
    "You are picking which Airtable table an Aquilla translation project should push its progress to.",
    "",
    `Project: ${summary.projectName}`,
    `Files (${summary.files.length}): ${summary.files.map((f) => f.fileName).slice(0, 40).join(", ") || "(none yet)"}`,
    "",
    "Tables available:",
    JSON.stringify(tables.map((t) => ({ tableId: t.tableId, table: t.tableName, base: t.baseName }))),
    "",
    "Prefer a table whose name or base matches the project, or that looks like a translation or progress tracker.",
    'Respond with STRICT JSON: {"tableId": "<id from the list>", "reason": "<one short sentence>"}',
  ].join("\n")

  let chosen: TableCandidate | undefined
  let reason = ""
  try {
    const parsed = parseJsonAnswer<{ tableId: unknown; reason: unknown }>(
      await callAnalysisLlm(env, await analysisModel(env), prompt, "airtable table selection"),
    )
    if (parsed && typeof parsed.tableId === "string") chosen = tables.find((t) => t.tableId === parsed.tableId)
    if (chosen && typeof parsed?.reason === "string") reason = parsed.reason
  } catch (err) {
    // The user can change the table in setup either way, so an AI outage
    // degrades the suggestion, not the flow.
    console.error("[airtable] table selection failed, falling back to name match:", err)
  }
  if (!chosen) {
    chosen = bestByName(tables, summary)
    reason = ""
  }
  return { ...chosen, reason }
}
