// PageIndex-style indexing (spec §"Data model"): structure comes from
// heuristics (markdown headings, else paragraph blocks), the LLM only writes
// summaries — one Haiku call per document, made async from the upload route
// via ctx.waitUntil. Failure is non-fatal: docs stay string-searchable.
//
// AQU-1376: this job is the only thing that moves a row off `pending`, and
// nothing revisits it afterwards — no cron, no retry. So every exit has to be
// terminal (`ready` or `failed`) and every failure has to be *loggable*:
// a silent exit strands the doc at "Indexing…" forever with no recovery UI.
//
// AQU-2002: the two legs are failable independently, and only one of them is
// the index. Segmentation is deterministic and local; the model call adds
// summaries and is the only leg with an upstream to lose. Treating a lost
// upstream as a failed *index* threw away the structure already built, parked
// the row at `failed` with nothing recorded, and made the retry button a
// deterministic dead end — press it, the same OpenRouter rejection comes back,
// the same bare "Indexing failed" badge appears (LOTE knowledge base,
// 2026-10). So an enrichment failure now lands as `ready` **without**
// summaries plus an `index_error` saying why, `failed` is reserved for a
// document there was nothing to index in, and every outcome ships a PostHog
// log — before this the whole pipeline emitted no telemetry at all, so "never
// indexed" could only be investigated by reading rows by hand.
import type { AquillaDb } from "../../../../db/shim/postgres"
import {
  getDocText, setIndexResult, type KnowledgeNode,
} from "../../../../db/shared/knowledge"
import { propagateKnowledgeDocs } from "../../../../db/shared/inherited-settings"
import { shipLog, type PosthogLogEnv } from "../../posthog-logs"

export interface KbIndexEnv extends PosthogLogEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  KB_INDEX_MODEL?: string
}

/** AQU-1376: hard ceiling on the enrichment round-trip. Without it a hung
 *  upstream response has nothing to abort it, the waitUntil task never settles,
 *  and the row stays `pending` for good. Must stay comfortably *below* the
 *  read-side staleness window (`KB_INDEX_STALE_MS` in
 *  src/lib/frontier/knowledge-base.ts) so a job still inside its own budget is
 *  never shown as stalled. */
export const KB_INDEX_FETCH_TIMEOUT_MS = 60_000

const MAX_NODES = 200
const MAX_DEPTH = 3
const BLOCK_TARGET = 2000
export const DEFAULT_KB_INDEX_MODEL = "anthropic/claude-haiku-4-5"

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm

export function segmentText(text: string): KnowledgeNode[] {
  const headings: { level: number; title: string; start: number }[] = []
  for (const m of text.matchAll(HEADING_RE)) {
    headings.push({ level: m[1].length, title: m[2].trim(), start: m.index ?? 0 })
  }
  let flat: { level: number; title: string; charStart: number; charEnd: number }[]
  if (headings.length >= 2) {
    flat = headings.slice(0, MAX_NODES).map((h, i, arr) => ({
      level: Math.min(h.level, MAX_DEPTH),
      title: h.title,
      charStart: h.start,
      charEnd: i + 1 < arr.length ? arr[i + 1].start : text.length,
    }))
    // Preamble before the first heading becomes its own node.
    if (headings[0].start > 0) {
      flat.unshift({ level: 1, title: "Introduction", charStart: 0, charEnd: headings[0].start })
    }
  } else {
    // Headingless: greedy paragraph blocks of ~BLOCK_TARGET chars, tiling
    // the full text with no gaps (each block's charEnd == next block's
    // charStart, and the very first/last ranges touch the text bounds).
    flat = []
    let start = 0
    while (start < text.length) {
      const isLast = flat.length === MAX_NODES - 1
      let end = Math.min(start + BLOCK_TARGET, text.length)
      if (!isLast && end < text.length) {
        const brk = text.indexOf("\n\n", start)
        if (brk >= 0 && brk < end) {
          // Prefer breaking at the *last* paragraph boundary before `end`.
          let lastBrk = brk
          let next = text.indexOf("\n\n", brk + 2)
          while (next >= 0 && next < end) {
            lastBrk = next
            next = text.indexOf("\n\n", next + 2)
          }
          end = lastBrk + 2
        }
      }
      if (isLast) end = text.length
      const firstLine = text.slice(start, end).trimStart().split("\n", 1)[0]
      flat.push({ level: 1, title: firstLine.slice(0, 80) || `Part ${flat.length + 1}`, charStart: start, charEnd: end })
      start = end
    }
    if (flat.length) flat[flat.length - 1].charEnd = text.length
  }
  // Nest by heading level (stack-based), assign hierarchical ids n1, n1.1, …
  const roots: KnowledgeNode[] = []
  const stack: { node: KnowledgeNode; level: number }[] = []
  for (const f of flat) {
    const node: KnowledgeNode = { id: "", title: f.title, charStart: f.charStart, charEnd: f.charEnd }
    while (stack.length && stack[stack.length - 1].level >= f.level) stack.pop()
    if (!stack.length) {
      node.id = `n${roots.length + 1}`
      roots.push(node)
    } else {
      const parent = stack[stack.length - 1].node
      parent.children = parent.children ?? []
      node.id = `${parent.id}.${parent.children.length + 1}`
      parent.children.push(node)
      // A parent's range must cover its children.
      parent.charEnd = Math.max(parent.charEnd, node.charEnd)
    }
    stack.push({ node, level: f.level })
  }
  return roots
}

export function buildEnrichmentPrompt(docName: string, text: string, nodes: KnowledgeNode[]): string {
  const flat: string[] = []
  const walk = (ns: KnowledgeNode[]) => {
    for (const n of ns) {
      flat.push(`${n.id}: "${n.title}"\n${text.slice(n.charStart, Math.min(n.charEnd, n.charStart + 1200))}`)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return [
    `Document: ${docName}. Below are its sections (id, title, opening text).`,
    `Return ONLY JSON: {"docSummary": "<2-3 sentence summary of the whole document>",`,
    ` "nodes": [{"id": "<section id>", "summary": "<1-2 sentence section summary>"}]}.`,
    `Cover every section id exactly once.`,
    "",
    flat.join("\n---\n"),
  ].join("\n")
}

export function applyEnrichment(
  nodes: KnowledgeNode[], raw: string,
): { tree: KnowledgeNode[]; docSummary: string | null } {
  // Models sometimes wrap JSON in a code fence — strip it before parsing.
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
  const parsed = JSON.parse(cleaned) as { docSummary?: string; nodes?: { id: string; summary?: string }[] }
  const byId = new Map((parsed.nodes ?? []).map((n) => [n.id, n.summary]))
  const walk = (ns: KnowledgeNode[]) => {
    for (const n of ns) {
      const s = byId.get(n.id)
      if (s) n.summary = s
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return { tree: nodes, docSummary: parsed.docSummary?.trim() || null }
}

function openRouterUrl(env: KbIndexEnv): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

/** The log message for each terminal outcome. Kept as literals so a PostHog
 *  query can be written against them without reading this file (AQU-2002). */
export const KB_INDEX_EVENT = {
  started: "kb-index-started",
  ready: "kb-index-ready",
  degraded: "kb-index-degraded",
  failed: "kb-index-failed",
} as const

/** Why a run could not produce summaries, in one sentence the uploader can act
 *  on. These land in `knowledge_docs.index_error` and are rendered verbatim in
 *  the knowledge-base list, so they name no internals — no stack, no table or
 *  column names, no key material (AQU-2002, same contract as the extraction
 *  messages in routes/parse-document.ts). */
export function describeIndexFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Workers raise an AbortError; a thrown-through rejection from a stubbed or
  // polyfilled fetch may only say so in its message.
  if (err instanceof Error && (err.name === "AbortError" || /\babort(ed)?\b/i.test(message))) {
    return `The summarizing model did not answer within ${Math.round(KB_INDEX_FETCH_TIMEOUT_MS / 1000)}s.`
  }
  if (message === "no OPENROUTER_API_KEY") {
    return "No summarizing model is configured in this environment."
  }
  const upstream = /^openrouter (\d{3})$/.exec(message)
  if (upstream) {
    const status = Number(upstream[1])
    if (status === 401 || status === 403) {
      return "The summarizing model refused our credentials — the OpenRouter key needs attention."
    }
    if (status === 402) {
      return "The summarizing model refused the request for billing reasons — the OpenRouter account is out of credit."
    }
    if (status === 429) {
      return "The summarizing model is rate-limiting us. Try again shortly."
    }
    return `The summarizing model returned HTTP ${status}.`
  }
  if (err instanceof SyntaxError) {
    return "The summarizing model returned a response that could not be read."
  }
  return "The summarizing step failed for an unexpected reason."
}

/** Ship one indexing-pipeline log line. Telemetry never decides the job's
 *  outcome, and `shipLog` is already a no-op without POSTHOG_KEY. */
function logIndexEvent(
  env: KbIndexEnv,
  level: "info" | "warn" | "error",
  event: string,
  attributes: Record<string, string | number | undefined>,
): Promise<void> {
  return shipLog(env, "aquilla-identity", level, event, attributes)
}

/** Build + persist the index for one doc. Never throws.
 *
 *  Outcomes (AQU-2002):
 *  - `ready`, `index_error` null — structure and summaries both landed.
 *  - `ready`, `index_error` set — structure landed, the model leg did not. The
 *    doc is searchable and navigable; only its summaries are missing, and the
 *    retry in the UI is there to add them.
 *  - `failed`, `index_error` set — there was nothing to index, or the job hit
 *    something it could not classify. The doc remains string-searchable
 *    (spec §Error handling).
 *
 *  `timeoutMs` overrides KB_INDEX_FETCH_TIMEOUT_MS; tests use it to exercise the
 *  abort path without waiting a minute. */
export async function indexKnowledgeDoc(
  env: KbIndexEnv,
  db: AquillaDb,
  docId: string,
  { timeoutMs = KB_INDEX_FETCH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  const startedAt = Date.now()
  try {
    const doc = await getDocText(db, docId)
    // No row: deleted while the job was queued. Nothing to index and nothing
    // to report — a log line here would read as a failure of this document.
    if (!doc) return
    await logIndexEvent(env, "info", KB_INDEX_EVENT.started, {
      "kb.doc_id": docId,
      "kb.scope": doc.meta.projectId ? "project" : "org",
      "kb.text_chars": doc.text.length,
    })

    const nodes = segmentText(doc.text)
    if (!nodes.length) {
      // Upload rejects text-free files, but a row can still arrive here
      // text-free (an inherited copy, a hand-edited row). Terminal, and no
      // retry can change it — say that rather than showing a bare "failed".
      const reason = "This document has no extractable text, so there is nothing to index."
      await setIndexResult(db, docId, "failed", null, null, reason)
      await logIndexEvent(env, "error", KB_INDEX_EVENT.failed, {
        "kb.doc_id": docId,
        "kb.reason": reason,
        "kb.duration_ms": Date.now() - startedAt,
      })
      return
    }

    let enriched: { tree: KnowledgeNode[]; docSummary: string | null } | null = null
    let degraded: string | undefined
    try {
      enriched = await enrichNodes(env, doc.meta.name, doc.text, nodes, timeoutMs)
    } catch (err) {
      // The structure in `nodes` is unaffected by this — keep it.
      console.error(`[knowledge] summarizing doc ${docId} failed:`, err)
      degraded = describeIndexFailure(err)
    }

    await setIndexResult(
      db,
      docId,
      "ready",
      enriched?.tree ?? nodes,
      enriched?.docSummary ?? null,
      degraded ?? null,
    )
    await logIndexEvent(
      env,
      degraded ? "warn" : "info",
      degraded ? KB_INDEX_EVENT.degraded : KB_INDEX_EVENT.ready,
      {
        "kb.doc_id": docId,
        "kb.nodes": nodes.length,
        "kb.reason": degraded,
        "kb.duration_ms": Date.now() - startedAt,
      },
    )

    if (doc.meta.projectId) {
      await propagateKnowledgeDocs(db, doc.meta.projectId, {
        updatedBy: doc.meta.createdBy,
      }).catch((err) => {
        console.error(`[knowledge] could not copy the index of ${docId} downstream:`, err)
      })
    }
  } catch (err) {
    // Everything the two legs above can throw is already handled, so landing
    // here means the persistence path itself broke. Log before the
    // compensating write, so the original cause survives even when that write
    // is what fails.
    console.error(`[knowledge] indexing doc ${docId} failed:`, err)
    const reason = "Indexing could not be completed. The document is still searchable; try again."
    await setIndexResult(db, docId, "failed", null, null, reason).catch((writeErr) => {
      // The row is now stuck at `pending` with no job left to move it. Nothing
      // here can fix that; the log is what makes it diagnosable, and the
      // read-side staleness window is what gives the owner a retry.
      console.error(`[knowledge] could not mark doc ${docId} failed:`, writeErr)
    })
    await logIndexEvent(env, "error", KB_INDEX_EVENT.failed, {
      "kb.doc_id": docId,
      "kb.reason": describeIndexFailure(err),
      "kb.duration_ms": Date.now() - startedAt,
    })
  }
}

/** The model leg: one call that returns summaries for the sections already
 *  segmented. Throws on anything that stops it; the caller decides what that
 *  means for the row. */
async function enrichNodes(
  env: KbIndexEnv,
  docName: string,
  text: string,
  nodes: KnowledgeNode[],
  timeoutMs: number,
): Promise<{ tree: KnowledgeNode[]; docSummary: string | null }> {
  if (!env.OPENROUTER_API_KEY) throw new Error("no OPENROUTER_API_KEY")
  // The signal has to outlive the fetch itself: reading the body can hang
  // just as easily as opening the connection, so it stays armed until the
  // JSON is in hand (AQU-1376).
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  let body: { choices?: { message?: { content?: string } }[] }
  try {
    const res = await fetch(openRouterUrl(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.KB_INDEX_MODEL || DEFAULT_KB_INDEX_MODEL,
        messages: [{ role: "user", content: buildEnrichmentPrompt(docName, text, nodes) }],
        response_format: { type: "json_object" },
      }),
      signal: abort.signal,
    })
    if (!res.ok) throw new Error(`openrouter ${res.status}`)
    body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  } finally {
    clearTimeout(timer)
  }
  return applyEnrichment(nodes, body.choices?.[0]?.message?.content ?? "")
}
