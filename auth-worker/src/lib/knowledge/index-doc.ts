// PageIndex-style indexing (spec §"Data model"): structure comes from
// heuristics in segment.ts (markdown headings, else paragraph blocks), the LLM
// only writes summaries — one Haiku call per document (per batch of sections
// for a large one, AQU-2029), made async from the upload route via
// ctx.waitUntil. Failure is non-fatal: docs stay string-searchable.
//
// AQU-1376: this job is the only thing that moves a row off `pending`, and
// nothing revisits it afterwards — no cron, no retry. So every exit has to be
// terminal (`ready` or `failed`) and every failure has to be *loggable*:
// a silent exit strands the doc at "Indexing…" forever with no recovery UI.
//
// AQU-2050: and every exit has to be terminal *inside the 30 seconds the
// platform grants a waitUntil task*, which the job's old 60s ceiling did not
// respect — a run needing 30–60s was cancelled with nothing written, which is
// the one way a row can still be stranded. So the budget is derived from that
// window and counted from the job's start, a request lost to it no longer
// discards the summaries its siblings returned, and the next run continues
// from what is on the row instead of starting the document over.
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
import { segmentText } from "./segment"
import { admitLlmCall, LlmRefusedError, projectOrgId, type PaidLlmEnv, type PaidScope } from "../billing/paid-llm"

export { segmentText }

/** The worker env: the model calls go through the AI entitlement check
 *  (AQU-2063), which needs the meter mode, the house keys and the rate card. */
export interface KbIndexEnv extends PosthogLogEnv, PaidLlmEnv {
  KB_INDEX_MODEL?: string
}

/** Output the meter reserves per summarizing call. The request sends no
 *  max_tokens (a clipped JSON reply would lose every summary in its batch), so
 *  this is only the reservation; settlement records the reported cost. */
const KB_RESERVE_OUTPUT_TOKENS = 8_192

/** What the platform grants a `ctx.waitUntil` task after the response is sent:
 *  "If any Promises have not settled after 30 seconds, they are canceled."
 *  A cancelled task writes nothing. */
export const KB_WAITUNTIL_WINDOW_MS = 30_000

/** What the terminal write, its log line and the downstream propagation need
 *  after the model leg hands back, still inside that window. */
const KB_TERMINAL_WRITE_MARGIN_MS = 6_000

/** AQU-1376: hard ceiling on the enrichment leg — all of its requests
 *  together, however many it takes (AQU-2029). Without it a hung upstream
 *  response has nothing to abort it, the waitUntil task never settles, and the
 *  row stays `pending` for good.
 *
 *  AQU-2050: it is a budget for the whole job, *measured from its start* and
 *  derived from the platform window rather than picked. It used to be a flat
 *  60s, set before that window was accounted for, so a run that needed between
 *  30 and 60 seconds was cancelled mid-flight: no `ready`, no `failed`, no
 *  reason, the row left at `pending` forever, and "Try indexing again" walking
 *  into the same cliff (Art of Survival_Arabic_clean.docx on dev, 2026-10-19 —
 *  30,940 ms, then "waitUntil() tasks did not complete… and have been
 *  cancelled"). The margin is what the terminal write needs once the budget is
 *  spent. Still far below the read-side staleness window (`KB_INDEX_STALE_MS`
 *  in src/lib/frontier/knowledge-base.ts), so a job inside its budget is never
 *  shown as stalled. */
export const KB_INDEX_BUDGET_MS = KB_WAITUNTIL_WINDOW_MS - KB_TERMINAL_WRITE_MARGIN_MS

/** AQU-2029: how much one enrichment request may carry. The model leg used to
 *  send every section in a single prompt, and the 200 sections of a
 *  fully-vowelled Arabic Bible (VanDyck_OT_1_Law_History.txt, 1.9M chars) came
 *  to 217,696 tokens against Haiku's 200,000. The provider refused it with a
 *  400, so every large reference document indexed without summaries, and no
 *  retry could change that. The budget is in characters, which are a poor proxy
 *  for tokens: English runs ~4 chars a token, that Arabic ~1, and some scripts
 *  several tokens a char. So it is sized for the worst case (even 4 tokens a
 *  char stays near 130k), not the average. The node cap bounds each response,
 *  so a batch finishes well inside the shared deadline too. */
export const KB_ENRICH_BATCH_CHARS = 32_000
export const KB_ENRICH_BATCH_NODES = 25
/** Per-section share of a prompt. Titles are capped as well as excerpts, so
 *  one section's entry is bounded and always fits a batch on its own. */
const SECTION_EXCERPT_CHARS = 1200
const SECTION_TITLE_CHARS = 200
const SECTION_SEPARATOR = "\n---\n"

export const DEFAULT_KB_INDEX_MODEL = "anthropic/claude-haiku-4-5"

/** Every section of the tree, parents before their children — document order. */
function flattenNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  const flat: KnowledgeNode[] = []
  const walk = (ns: KnowledgeNode[]) => {
    for (const n of ns) {
      flat.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return flat
}

function sectionEntry(text: string, n: KnowledgeNode): string {
  const excerpt = text.slice(n.charStart, Math.min(n.charEnd, n.charStart + SECTION_EXCERPT_CHARS))
  return `${n.id}: "${n.title.slice(0, SECTION_TITLE_CHARS)}"\n${excerpt}`
}

/** Splits the tree's sections, in document order, into the requests the model
 *  leg sends: each stays under KB_ENRICH_BATCH_CHARS of section text and
 *  KB_ENRICH_BATCH_NODES sections, and every section lands in exactly one
 *  (AQU-2029). */
export function batchSections(text: string, nodes: KnowledgeNode[]): KnowledgeNode[][] {
  return batchSectionList(text, flattenNodes(nodes))
}

/** The same split over an explicit list of sections in document order: a
 *  re-index batches only the sections still owed a summary, never the whole
 *  tree again (AQU-2050). */
export function batchSectionList(text: string, sections: KnowledgeNode[]): KnowledgeNode[][] {
  const batches: KnowledgeNode[][] = []
  let batch: KnowledgeNode[] = []
  let chars = 0
  for (const n of sections) {
    const size = sectionEntry(text, n).length + SECTION_SEPARATOR.length
    if (batch.length && (batch.length >= KB_ENRICH_BATCH_NODES || chars + size > KB_ENRICH_BATCH_CHARS)) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(n)
    chars += size
  }
  if (batch.length) batches.push(batch)
  return batches
}

/** The section-summary prompt for one batch. A document that fits one batch
 *  gets its whole-document summary from the same call; for a larger one the
 *  batch sees only part of the document, so that summary comes from
 *  `buildDocSummaryPrompt` once every batch is back. */
export function buildEnrichmentPrompt(
  docName: string,
  text: string,
  sections: KnowledgeNode[],
  { wholeDocument = true }: { wholeDocument?: boolean } = {},
): string {
  return [
    wholeDocument
      ? `Document: ${docName}. Below are its sections (id, title, opening text).`
      : `Document: ${docName}. Below are some of its sections (id, title, opening text).`,
    wholeDocument
      ? `Return ONLY JSON: {"docSummary": "<2-3 sentence summary of the whole document>",`
      : `Return ONLY JSON: {`,
    ` "nodes": [{"id": "<section id>", "summary": "<1-2 sentence section summary>"}]}.`,
    `Cover every section id exactly once.`,
    "",
    sections.map((n) => sectionEntry(text, n)).join(SECTION_SEPARATOR),
  ].join("\n")
}

/** The whole-document summary of a multi-batch document, written from the
 *  section summaries the batches returned rather than from the text, which no
 *  single prompt can hold (AQU-2029). */
export function buildDocSummaryPrompt(
  docName: string, sections: KnowledgeNode[], summaries: ReadonlyMap<string, string>,
): string {
  // Capped per line so even a 200-section outline stays near 80k chars.
  const outline = sections.map((n) => {
    const summary = summaries.get(n.id)
    return `${n.id}: "${n.title.slice(0, 80)}"${summary ? ` — ${summary.slice(0, 300)}` : ""}`
  })
  return [
    `Document: ${docName}. Below is an outline of its sections in order (id, title, summary).`,
    `Return ONLY JSON: {"docSummary": "<2-3 sentence summary of the whole document>"}.`,
    "",
    outline.join("\n"),
  ].join("\n")
}

interface EnrichmentReply {
  docSummary?: string
  nodes?: { id: string; summary?: string }[]
}

function parseReply(raw: string): EnrichmentReply {
  // Models sometimes wrap JSON in a code fence — strip it before parsing.
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
  return JSON.parse(cleaned) as EnrichmentReply
}

function collectSummaries(reply: EnrichmentReply, into = new Map<string, string>()): Map<string, string> {
  for (const n of reply.nodes ?? []) {
    if (typeof n.summary === "string" && n.summary) into.set(n.id, n.summary)
  }
  return into
}

function mergeSummaries(nodes: KnowledgeNode[], summaries: ReadonlyMap<string, string>): void {
  for (const n of flattenNodes(nodes)) {
    const s = summaries.get(n.id)
    if (s) n.summary = s
  }
}

/** Summaries already on the row that still describe the same section of the
 *  freshly segmented tree. A re-index starts from these and pays only for the
 *  sections still owed one (AQU-2050) — before this every run re-summarized
 *  the whole document, so a document that could not finish in one run could
 *  never finish at all. A stored node counts only when its id, title and
 *  char range all still match, so a tree built by an older segmentation never
 *  grafts a summary onto the wrong section. */
export function carryOverSummaries(
  nodes: KnowledgeNode[], stored: KnowledgeNode[] | null,
): Map<string, string> {
  const kept = new Map<string, string>()
  if (!stored) return kept
  const priorById = new Map(flattenNodes(stored).map((n) => [n.id, n]))
  for (const n of flattenNodes(nodes)) {
    const prior = priorById.get(n.id)
    if (prior?.summary && prior.title === n.title
      && prior.charStart === n.charStart && prior.charEnd === n.charEnd) {
      kept.set(n.id, prior.summary)
    }
  }
  return kept
}

/** The sections of the tree still without a summary, in document order. */
function unsummarized(nodes: KnowledgeNode[]): KnowledgeNode[] {
  return flattenNodes(nodes).filter((n) => !n.summary)
}

function summariesOf(nodes: KnowledgeNode[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of flattenNodes(nodes)) if (n.summary) out.set(n.id, n.summary)
  return out
}

export function applyEnrichment(
  nodes: KnowledgeNode[], raw: string,
): { tree: KnowledgeNode[]; docSummary: string | null } {
  const parsed = parseReply(raw)
  mergeSummaries(nodes, collectSummaries(parsed))
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

/** How providers word a prompt that does not fit the model's context:
 *  Anthropic/Bedrock "prompt is too long: N tokens > M maximum", OpenRouter and
 *  OpenAI-style "maximum context length is N tokens" / `context_length_exceeded`. */
const CONTEXT_OVERFLOW_RE = /prompt is too long|maximum context length|context[_ ]length|too many tokens/i

/** The provider's own words from an OpenRouter error body, for the logs only:
 *  `describeIndexFailure` never shows them to the uploader. OpenRouter wraps a
 *  provider's rejection as `{"error": {"message": "Provider returned error",
 *  "metadata": {"raw": "<provider body>"}}}`, and the useful sentence is in
 *  `raw` (AQU-2029: "prompt is too long: 217696 tokens > 200000 maximum"). */
function upstreamDetail(body: string): string {
  let detail = body
  try {
    const { error } = JSON.parse(body) as { error?: { message?: unknown; metadata?: { raw?: unknown } } }
    const said = error?.metadata?.raw ?? error?.message
    if (typeof said === "string") detail = said
  } catch {
    // Not JSON (a gateway's HTML error page, say): keep the text as it came.
  }
  return detail.replace(/\s+/g, " ").trim().slice(0, 300)
}

/** Why a run could not produce summaries, in one sentence the uploader can act
 *  on. These land in `knowledge_docs.index_error` and are rendered verbatim in
 *  the knowledge-base list, so they name no internals — no stack, no table or
 *  column names, no key material (AQU-2002, same contract as the extraction
 *  messages in routes/parse-document.ts). */
export function describeIndexFailure(err: unknown): string {
  // AQU-2063: the AI entitlement check refused the call before it spent.
  if (err instanceof LlmRefusedError) {
    return err.refusal.status === 402
      ? "This workspace has used its AI allowance for the week. Try indexing again after it resets."
      : "AI summarizing is paused right now. Try again later."
  }
  const message = err instanceof Error ? err.message : String(err)
  // Workers raise an AbortError; a thrown-through rejection from a stubbed or
  // polyfilled fetch may only say so in its message.
  if (err instanceof Error && (err.name === "AbortError" || /\babort(ed)?\b/i.test(message))) {
    return "The summarizing model did not answer within the time this run had."
  }
  if (message === "no OPENROUTER_API_KEY") {
    return "No summarizing model is configured in this environment."
  }
  const upstream = /^openrouter (\d{3})(?::\s*([\s\S]*))?$/.exec(message)
  if (upstream) {
    const status = Number(upstream[1])
    // AQU-2029: batching keeps prompts far under the model's context, but a
    // script that tokenizes worse than the budget assumes can still overflow
    // one. "Returned HTTP 400" told the uploader nothing about that.
    if (status === 413 || (status === 400 && CONTEXT_OVERFLOW_RE.test(upstream[2] ?? ""))) {
      return "This document is too large for the summarizing model to read in one pass."
    }
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

/** The reason on a run that lost part of the model leg: the cause, then where
 *  the work now stands, so "Try indexing again" reads as the next step rather
 *  than a repeat of the same dead end (AQU-2050 / the AQU-2002 rule). Rendered
 *  verbatim in the knowledge-base list, like every other reason here, so it
 *  names no internals. */
export function describeIncomplete(
  err: unknown, sectionsDone: number, sectionsTotal: number, hasDocSummary: boolean,
): string {
  const cause = describeIndexFailure(err)
  const missing = sectionsTotal - sectionsDone
  // Nothing landed at all: the cause is the whole story, and there is no
  // progress for the retry to continue from.
  if (!sectionsDone) return cause
  if (missing > 0) {
    return `${cause} Summaries are missing for ${missing} of ${sectionsTotal} sections — “Try indexing again” continues from there.`
  }
  if (!hasDocSummary) {
    return `${cause} Every section is summarized — “Try indexing again” adds the document summary.`
  }
  return cause
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
 *  A run that could not produce every summary lands in the second of those
 *  outcomes and says how far it got, and the next run continues from there
 *  rather than starting the document over (AQU-2050).
 *
 *  `timeoutMs` overrides KB_INDEX_BUDGET_MS; tests use it to exercise the
 *  deadline without waiting out the real budget. */
export async function indexKnowledgeDoc(
  env: KbIndexEnv,
  db: AquillaDb,
  docId: string,
  { timeoutMs = KB_INDEX_BUDGET_MS }: { timeoutMs?: number } = {},
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

    // Whatever an earlier run already paid for stays on the tree, so the model
    // leg only asks for the sections still owed a summary (AQU-2050).
    mergeSummaries(nodes, carryOverSummaries(nodes, doc.tree))
    const sectionsTotal = flattenNodes(nodes).length

    let docSummary = doc.meta.docSummary
    let lost: { err: unknown } | null = null
    try {
      // AQU-2063: indexing runs after the upload response, with no live user,
      // so it bills the doc's org as the system user (spec §3.3).
      const paid: PaidCtx = {
        db,
        scope: {
          orgId: doc.meta.orgId ?? (doc.meta.projectId ? await projectOrgId(db, doc.meta.projectId) : null),
          userId: null,
          projectId: doc.meta.projectId,
          rail: "llm",
        },
      }
      const outcome = await enrichNodes(
        env, paid, doc.meta.name, doc.text, nodes, docSummary, startedAt + timeoutMs,
      )
      docSummary = outcome.docSummary
      if ("error" in outcome) lost = { err: outcome.error }
    } catch (err) {
      // A leg that could not start at all. The structure in `nodes`, and
      // anything carried onto it, is unaffected — keep it.
      lost = { err }
    }

    const sectionsDone = sectionsTotal - unsummarized(nodes).length
    let degraded: string | undefined
    let cause: string | undefined
    if (lost) {
      console.error(`[knowledge] summarizing doc ${docId} failed:`, lost.err)
      degraded = describeIncomplete(lost.err, sectionsDone, sectionsTotal, !!docSummary)
      // The reason is written for the uploader and drops the provider's own
      // words; telemetry keeps them, so one 400 can be told from the next
      // (AQU-2029).
      cause = (lost.err instanceof Error ? lost.err.message : String(lost.err)).slice(0, 500)
    }

    await setIndexResult(db, docId, "ready", nodes, docSummary, degraded ?? null)
    await logIndexEvent(
      env,
      degraded ? "warn" : "info",
      degraded ? KB_INDEX_EVENT.degraded : KB_INDEX_EVENT.ready,
      {
        "kb.doc_id": docId,
        "kb.nodes": nodes.length,
        // How far the leg got, so a deadline can be told from a provider
        // error without reading the reason (AQU-2002, AQU-2050).
        "kb.sections_total": sectionsTotal,
        "kb.sections_done": sectionsDone,
        "kb.reason": degraded,
        "kb.error": cause,
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

/** The model leg: summaries for the sections still owed one, then the document
 *  summary. A document that fits one batch takes one call, as it always has.
 *  A larger one is summarized in parallel batches, then a final call writes the
 *  document summary from theirs (AQU-2029). `nodes` is enriched in place.
 *
 *  It throws only for a leg that cannot start at all. A request lost to the
 *  deadline or to the provider is reported as `error` instead, with whatever
 *  the other requests returned already merged: discarding those was what made
 *  the retry a deterministic dead end, because every run then had to summarize
 *  the whole document again inside one budget (AQU-2050). */
async function enrichNodes(
  env: KbIndexEnv,
  paid: PaidCtx,
  docName: string,
  text: string,
  nodes: KnowledgeNode[],
  priorDocSummary: string | null,
  deadlineAt: number,
): Promise<{ docSummary: string | null; error?: unknown }> {
  if (!env.OPENROUTER_API_KEY) throw new Error("no OPENROUTER_API_KEY")
  const all = flattenNodes(nodes)
  const pending = unsummarized(nodes)
  // Nothing owed and the document summary already written: re-indexing a
  // complete row costs no requests and changes nothing.
  if (!pending.length && priorDocSummary) return { docSummary: priorDocSummary }

  // One deadline for the whole leg, however many requests it makes, counted
  // from the job's start: the budget is what the platform's waitUntil window,
  // the staleness window and the re-index debounce are all sized against. The
  // signal stays armed until every body is in hand, because reading a body can
  // hang just as easily as opening the connection (AQU-1376).
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), Math.max(0, deadlineAt - Date.now()))
  try {
    const batches = batchSectionList(text, pending)
    // The one request that sees every section of the document writes its
    // summary too; anything less has to wait for the outline call below.
    if (batches.length === 1 && pending.length === all.length) {
      try {
        return { docSummary: applyEnrichment(nodes, await complete(
          env, paid, buildEnrichmentPrompt(docName, text, batches[0]), abort.signal,
        )).docSummary }
      } catch (err) {
        return { docSummary: null, error: err }
      }
    }
    // At most ceil(MAX_NODES / KB_ENRICH_BATCH_NODES) requests, all at once:
    // in sequence they could not be counted on to fit the shared deadline.
    // `allSettled`, not `all` — a batch already back has paid for its
    // summaries, and the deadline cancelling its siblings is no reason to
    // throw them away.
    const settled = await Promise.allSettled(batches.map((batch) => complete(
      env, paid, buildEnrichmentPrompt(docName, text, batch, { wholeDocument: false }), abort.signal,
    )))
    let error: unknown
    const summaries = new Map<string, string>()
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        error ??= outcome.reason
        continue
      }
      // Each reply is parsed on its own, so one unreadable batch costs only
      // its own sections.
      try {
        collectSummaries(parseReply(outcome.value), summaries)
      } catch (err) {
        error ??= err
      }
    }
    mergeSummaries(nodes, summaries)
    // A lost request leaves sections owed, so the document summary — written
    // from the section summaries — waits for the run that completes them.
    if (error !== undefined) return { docSummary: priorDocSummary, error }
    try {
      const docReply = await complete(
        env, paid, buildDocSummaryPrompt(docName, all, summariesOf(nodes)), abort.signal,
      )
      return { docSummary: parseReply(docReply).docSummary?.trim() || priorDocSummary }
    } catch (err) {
      return { docSummary: priorDocSummary, error: err }
    }
  } finally {
    clearTimeout(timer)
    // Done or failed, nothing of this leg may outlive it: when one batch
    // throws, its siblings are still in flight.
    abort.abort()
  }
}

/** One chat completion; resolves to the reply text. A non-2xx throws
 *  `openrouter <status>: <provider's words>` so the cause reaches the logs,
 *  and describeIndexFailure can tell a context overflow from any other 400
 *  (AQU-2029). */
interface PaidCtx { db: AquillaDb; scope: PaidScope }

async function complete(env: KbIndexEnv, paid: PaidCtx, prompt: string, signal: AbortSignal): Promise<string> {
  const model = env.KB_INDEX_MODEL || DEFAULT_KB_INDEX_MODEL
  // AQU-2063: admitted before it spends; a refusal reaches the uploader
  // through describeIndexFailure.
  const call = await admitLlmCall(paid.db, env, paid.scope, {
    model, promptChars: prompt.length, maxOutputTokens: KB_RESERVE_OUTPUT_TOKENS,
  })
  if (!call.ok) throw new LlmRefusedError(call)
  const res = await fetch(openRouterUrl(env), {
    method: "POST",
    headers: { Authorization: `Bearer ${call.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      // Without this OpenRouter reports no cost, and the call cannot settle.
      usage: { include: true },
    }),
    signal,
  })
  if (!res.ok) {
    const detail = upstreamDetail(await res.text().catch(() => ""))
    throw new Error(`openrouter ${res.status}${detail ? `: ${detail}` : ""}`)
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  await call.settleFrom(body)
  return body.choices?.[0]?.message?.content ?? ""
}
