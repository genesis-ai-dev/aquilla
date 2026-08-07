// verify — the three verifier stances as data + one execution path (graph
// nodes `verify_force` / `verify_ambiguity` / `verify_naturalness`).
//
// Independence is the point: a verifier receives the SCENE BRIEF and the
// DRAFT, never the performer's reasoning — inherited framing is how panels
// rubber-stamp. Each stance is adversarial ("find a failure"), covering one
// of the model's three failure families.

import type { CellPair } from "../agent/tools/select-cells"
import {
  chargeBudget,
  type AmbiguityEntry,
  type CellVerdict,
  type LlmCall,
  type RunBudget,
  type SpanDraft,
  type Tier,
  type VerifierKey,
  type Vote,
} from "./types"

export const STANCES: Record<VerifierKey, { tier: Tier; stance: string }> = {
  force: {
    tier: "deep",
    stance:
      "Find a move whose social force the draft alters — a command softened to a suggestion, a rebuke flattened to a remark, a plea hardened to a demand. Judge force against the scene brief's tenor and moves.",
  },
  ambiguity: {
    tier: "deep",
    stance:
      "Find where the draft resolves an ambiguity the register marks as preserved. Imposing an interpretation is as much a failure as an error: if the source leaves a question open and the draft closes it, reject that cell and name the register entry it violates.",
  },
  naturalness: {
    tier: "mid",
    stance:
      "Find target wording no native speaker would use in this situation — source-syntax calques, unidiomatic collocations, register mismatches. Judge against how a native speaker would actually say this in the scene.",
  },
}

export interface VerifySpanDeps {
  sceneBrief: {
    spanId: string
    l1Summary: string
    ambiguityRegister: AmbiguityEntry[]
  }
  draft: SpanDraft
  /** Source pairs for the drafted cells (verifiers compare against source). */
  pairs: CellPair[]
  llm: LlmCall
  budget: RunBudget
}

export type VerifySpanResult = { ok: true; vote: Vote } | { ok: false; error: string }

function verifierSystemPrompt(key: VerifierKey, deps: VerifySpanDeps): string {
  const registerBlock =
    deps.sceneBrief.ambiguityRegister.length > 0
      ? `\nAmbiguity register (each item must stay OPEN in the draft):\n${deps.sceneBrief.ambiguityRegister.map((a) => `- [${a.id}] ${a.question}`).join("\n")}\n`
      : "\nAmbiguity register: (empty)\n"
  // [[ctx:verify:<stance>]] routes the scripted e2e mock (scripts/mock-openrouter.ts).
  return `[[ctx:verify:${key}]] You are an independent translation verifier. Your single stance: ${STANCES[key].stance}

Scene brief: ${deps.sceneBrief.l1Summary}
${registerBlock}
You see the brief and the draft only — you have no access to the drafter's reasoning, and you owe it nothing. Approve a cell only if you actively looked for your failure mode there and found none.

Output STRICT JSON only, no prose, no code fences:
{"approve":true,"reason":"…","cells":[{"i":1,"approve":true,"reason":"…"}]}
One entry per numbered cell; "reason" is required on every disapproval.`
}

function draftBlock(deps: VerifySpanDeps): string {
  const sourceById = new Map(deps.pairs.map((p) => [p.cellId, p]))
  return deps.draft.cells
    .map((c, i) => {
      const p = sourceById.get(c.cellId)
      const ref = p?.canonicalRef ? ` (${p.canonicalRef})` : ""
      return `${i + 1}.${ref}\n   source: ${p?.source ?? "(unknown)"}\n   draft:  ${c.text}`
    })
    .join("\n")
}

interface RawCellVerdict {
  i?: unknown
  approve?: unknown
  reason?: unknown
}

/** Tolerant parse of the verifier's JSON verdict object. */
export function parseVoteReply(
  content: string,
  key: VerifierKey,
  draft: SpanDraft,
): Vote | null {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as {
      approve?: unknown
      reason?: unknown
      cells?: unknown
    }
    if (typeof raw !== "object" || raw === null || typeof raw.approve !== "boolean") return null
    const cellVerdicts: CellVerdict[] = []
    const rawCells = Array.isArray(raw.cells) ? (raw.cells as RawCellVerdict[]) : []
    for (const rc of rawCells) {
      if (typeof rc !== "object" || rc === null) continue
      if (typeof rc.i !== "number" || typeof rc.approve !== "boolean") continue
      const cell = draft.cells[rc.i - 1]
      if (!cell) continue
      cellVerdicts.push({
        cellId: cell.cellId,
        approve: rc.approve,
        ...(typeof rc.reason === "string" && rc.reason ? { reason: rc.reason } : {}),
      })
    }
    return {
      spanId: draft.spanId,
      verifier: key,
      approve: raw.approve,
      cellVerdicts,
      reason: typeof raw.reason === "string" ? raw.reason : "",
    }
  } catch {
    return null
  }
}

export async function verifySpan(
  stanceKey: VerifierKey,
  deps: VerifySpanDeps,
): Promise<VerifySpanResult> {
  const tier = STANCES[stanceKey].tier
  const charge = chargeBudget(deps.budget, tier)
  if (!charge.ok) return { ok: false, error: `budget: ${charge.reason}` }

  const reply = await deps.llm({
    system: verifierSystemPrompt(stanceKey, deps),
    user: `Verify these ${deps.draft.cells.length} drafted cells:\n${draftBlock(deps)}`,
    tier,
    maxTokens: 2048,
    temperature: 0,
    label: `verify:${stanceKey}`,
  })
  const vote = parseVoteReply(reply, stanceKey, deps.draft)
  if (!vote) return { ok: false, error: `${stanceKey} verifier returned no parseable verdict` }
  return { ok: true, vote }
}
