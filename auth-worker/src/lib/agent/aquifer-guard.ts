// Validates the agent's execute.aquifer argument into a typed op.
//
// The model supplies { op, ... }; this returns a discriminated union the
// executeToolCall handler can switch on, or a human-readable error string the
// model sees as the tool result (so it can self-correct). Pairs with the
// shared client in lib/aquifer/client.ts and the gate in lib/aquifer/gate.ts.

import type { AquiferCitation } from "../aquifer/client"
import { normalizeAquiferPath } from "../aquifer/client"

export type AquiferOp =
  | { op: "search"; q: string; limit?: number }
  | { op: "read"; path: string; maxChars?: number }
  | {
      op: "publish"
      question: string
      answer: string
      status: "answered" | "undetermined"
      citations: AquiferCitation[]
    }

export type AquiferOpResult = { ok: true; value: AquiferOp } | { ok: false; error: string }

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

function parseCitations(raw: unknown): AquiferCitation[] | string {
  if (!Array.isArray(raw) || raw.length < 1) {
    return "publish requires a non-empty citations array, each with a url"
  }
  const out: AquiferCitation[] = []
  for (const c of raw) {
    if (!c || typeof c !== "object") return "each citation must be an object with a url"
    const url = asString((c as Record<string, unknown>).url)
    if (!url) return "each citation requires a url"
    const title = asString((c as Record<string, unknown>).title)
    const quote = asString((c as Record<string, unknown>).quote)
    out.push({ url, ...(title ? { title } : {}), ...(quote ? { quote } : {}) })
  }
  return out
}

/** Validate `args.aquifer` (already known to be a non-null object). */
export function parseAquiferOp(raw: unknown): AquiferOpResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "aquifer must be an object: {op, ...}" }
  }
  const a = raw as Record<string, unknown>
  const op = asString(a.op)
  if (!op) return { ok: false, error: 'aquifer.op is required: "search" | "read" | "publish"' }

  if (op === "search") {
    const q = asString(a.q)
    if (!q) return { ok: false, error: "aquifer search requires q (the query text)" }
    const limit = typeof a.limit === "number" && Number.isFinite(a.limit) ? a.limit : undefined
    return { ok: true, value: { op: "search", q, ...(limit ? { limit } : {}) } }
  }

  if (op === "read") {
    const path = asString(a.path)
    if (!path) return { ok: false, error: "aquifer read requires path (e.g. /en/passages/RUT/1/8/)" }
    if (!normalizeAquiferPath(path)) {
      return { ok: false, error: `aquifer read path is not a valid site path: ${path.slice(0, 80)}` }
    }
    const maxChars = typeof a.maxChars === "number" && Number.isFinite(a.maxChars) ? a.maxChars : undefined
    return { ok: true, value: { op: "read", path, ...(maxChars ? { maxChars } : {}) } }
  }

  if (op === "publish") {
    const question = asString(a.question)
    const answer = asString(a.answer)
    if (!question || !answer) {
      return { ok: false, error: "aquifer publish requires question and answer" }
    }
    const status = a.status === "undetermined" ? "undetermined" : "answered"
    const citations = parseCitations(a.citations)
    if (typeof citations === "string") return { ok: false, error: citations }
    return { ok: true, value: { op: "publish", question, answer, status, citations } }
  }

  return { ok: false, error: `unknown aquifer.op "${op}" — use search | read | publish` }
}
