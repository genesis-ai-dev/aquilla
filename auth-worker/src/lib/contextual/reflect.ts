// reflect — park-time reflection (AQU-1302).
//
// A run that drafts twenty passages currently leaves nothing durable behind
// about the CHOICES it made: the drafts are reviewable one by one, but the
// register decision the reviewer kept enforcing, or the rendering the run
// settled on for a recurring term, dies with the run. Memory proposals existed
// only in the chat harness, as a tool the model may or may not call.
//
// So: when a run parks — allowance spent, an open decision, or work exhausted —
// it reflects ONCE over what it did since the last reflection and proposes at
// most three ABSTRACTED memories through the same `proposed` path a chat
// proposal takes. A human still approves every one.
//
// Three bounds make this safe to run at every park:
//   * it needs at least MIN_SPANS_SINCE_REFLECTION passages of new work, so the
//     one-span default a fresh run starts under (AQU-1300) proposes nothing;
//   * it costs exactly one model call, charged against a small budget;
//   * it is best-effort throughout — a model failure logs and the run parks
//     exactly as it would have. Reflection is a bonus, never a gate.

import { createProposal, listMemories } from "../../../../db/shared/agent-memory"
import {
  markRunReflected,
  type ContextualRun,
} from "../../../../db/shared/contextual-runs"
import type { AquillaDb } from "../../../../db/shim/postgres"
import { loadProjectContext } from "./project-context"
import { chargeBudget, createRunBudget, type LlmCall } from "./types"

/** Passages of new work a reflection needs. One passage is the fresh-run
 *  default (AQU-1300); reflecting on it would be one model call per passage
 *  wearing a different hat, which is the noise that allowance exists to stop. */
export const MIN_SPANS_SINCE_REFLECTION = 2

/** Hard cap per reflection. Zero is a valid — and for a short run, expected —
 *  outcome; a human reviewing fifteen notes reviews none of them. */
export const MAX_REFLECTION_PROPOSALS = 3

/** Evidence bounds. A reflection reads a sample of the run's work, not the
 *  whole file: the point is the recurring choice, which a sample shows. */
export const MAX_REFLECTION_DRAFTS = 24
export const MAX_REFLECTION_DRAFT_CHARS = 400
export const MAX_REFLECTION_DIRECTIONS = 10
export const MAX_REFLECTION_DECISIONS = 8
/** Known-context bounds — these exist to make the model SKIP, so they are
 *  listed generously but still bounded. */
export const MAX_REFLECTION_KNOWN = 40

const NOTE_TITLE_MAX_CHARS = 120
const NOTE_CONTENT_MAX_CHARS = 1200
const NOTE_RATIONALE_MAX_CHARS = 400

/** Reflection's own budget: one mid-tier call, with a second only if a caller
 *  ever retries. It never eats into a span's drafting budget. */
const REFLECTION_MAX_UNITS = 10
const REFLECTION_MAX_CALLS = 2

/** Where reflection-authored memories live, so the Memory tab (and a human
 *  scanning paths) can tell them from hand-authored ones at a glance. */
export const REFLECTION_PATH_PREFIX = "autopilot/"

export interface ReflectionEvidence {
  /** Drafts staged since the last reflection — the run's actual output. */
  drafts: { label: string | null; text: string }[]
  /** Steering directions the run consumed since then. */
  directions: string[]
  /** Decisions this run raised that a human answered since then. */
  answeredDecisions: { question: string; answer: string }[]
}

/** What the project ALREADY knows. Passed so the model skips it rather than
 *  re-proposing it as news. */
export interface ReflectionKnown {
  targetLanguage?: string
  memories: { path: string; content: string }[]
  rules: string[]
  terms: string[]
}

export interface ReflectionNote {
  path: string
  content: string
  rationale: string
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function bullets(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(none)"
}

export function reflectionSystemPrompt(): string {
  // [[ctx:reflect]] routes the scripted e2e mock (scripts/mock-openrouter.ts).
  return `[[ctx:reflect]] You are reviewing what a translation autopilot run just did, to record what a FUTURE run should know.

Propose at most ${MAX_REFLECTION_PROPOSALS} notes. Each note must be an ABSTRACTION — a convention, a register decision, or a recurring term rendering WITH its reason — that will still be true on the next passage. Never restate or summarize an individual draft.

Do not propose anything already covered by the project's approved notes, rules, or terminology listed below; those are already in force. If nothing recurring happened, propose nothing: an empty list is a correct and common answer.

Reply with JSON only, no prose and no code fence:
{"notes":[{"title":"short name","note":"the guidance, in a sentence or three","why":"what in the run's work justifies it"}]}`
}

export function reflectionUserPrompt(
  evidence: ReflectionEvidence,
  known: ReflectionKnown,
): string {
  const drafts = evidence.drafts.map((draft) =>
    `${draft.label ? `[${draft.label}] ` : ""}${draft.text.slice(0, MAX_REFLECTION_DRAFT_CHARS)}`,
  )
  const decisions = evidence.answeredDecisions.map(
    (decision) => `Q: ${decision.question}\n  A: ${decision.answer}`,
  )
  return [
    known.targetLanguage ? `## Target language\n${known.targetLanguage}` : "",
    `## Drafts this run staged\n${bullets(drafts)}`,
    `## Directions the reviewer sent\n${bullets(evidence.directions)}`,
    `## Questions a human answered\n${bullets(decisions)}`,
    `## Already approved notes (do not re-propose)\n${bullets(
      known.memories.map((memory) => `${memory.path}: ${memory.content.slice(0, 200)}`),
    )}`,
    `## Project rules already in force (do not re-propose)\n${bullets(known.rules)}`,
    `## Terminology already recorded (do not re-propose)\n${bullets(known.terms)}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Title → memory path. Derived in CODE rather than taken from the model: a
 *  path is a storage key with a shape contract (agent-memory MEMORY_PATH_RE),
 *  and a model asked for one produces `Autopilot/Register_Notes.MD` often
 *  enough that accepting it would drop otherwise good notes. */
export function reflectionPathFromTitle(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
  return `${REFLECTION_PATH_PREFIX}${slug || `note-${index + 1}`}.md`
}

function asTrimmedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

/** Pull the JSON body out of a model reply that may be fenced or padded with
 *  prose. Returns null when there is nothing parseable — a reflection that
 *  cannot be read proposes nothing, which is a valid outcome. */
function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  const candidates = [text]
  const objectStart = text.indexOf("{")
  const objectEnd = text.lastIndexOf("}")
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1))
  }
  const arrayStart = text.indexOf("[")
  const arrayEnd = text.lastIndexOf("]")
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayEnd + 1))
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next framing.
    }
  }
  return null
}

/**
 * Parse a reflection reply into at most MAX_REFLECTION_PROPOSALS notes.
 * Malformed entries are DROPPED, never repaired: a note with no guidance in it
 * is a review chore with no payoff.
 */
export function parseReflectionNotes(raw: string): ReflectionNote[] {
  const parsed = extractJson(raw)
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { notes?: unknown } | null)?.notes)
      ? ((parsed as { notes: unknown[] }).notes)
      : []
  const notes: ReflectionNote[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (notes.length >= MAX_REFLECTION_PROPOSALS) break
    if (!entry || typeof entry !== "object") continue
    const row = entry as Record<string, unknown>
    const title = asTrimmedString(row.title, NOTE_TITLE_MAX_CHARS)
    const content = asTrimmedString(row.note ?? row.content, NOTE_CONTENT_MAX_CHARS)
    if (!title || !content) continue
    const path = reflectionPathFromTitle(title, notes.length)
    if (seen.has(path)) continue
    seen.add(path)
    notes.push({
      path,
      content: `# ${title}\n\n${content}`,
      rationale: asTrimmedString(row.why ?? row.rationale, NOTE_RATIONALE_MAX_CHARS)
        || "Proposed by an autopilot run at park.",
    })
  }
  return notes
}

// ── The reflection call ─────────────────────────────────────────────────────

/** True when the run has done enough NEW work to be worth reflecting on. */
export function shouldReflect(run: ContextualRun): boolean {
  return run.doneSpans - run.reflectedDoneSpans >= MIN_SPANS_SINCE_REFLECTION
}

/** One model call over the run's evidence. Returns the parsed notes; the
 *  caller decides what to persist. */
export async function reflectOnRun(deps: {
  llm: LlmCall
  evidence: ReflectionEvidence
  known: ReflectionKnown
}): Promise<ReflectionNote[]> {
  const budget = createRunBudget({
    maxUnits: REFLECTION_MAX_UNITS,
    maxCalls: REFLECTION_MAX_CALLS,
  })
  const charge = chargeBudget(budget, "mid")
  if (!charge.ok) return []
  const reply = await deps.llm({
    system: reflectionSystemPrompt(),
    user: reflectionUserPrompt(deps.evidence, deps.known),
    tier: "mid",
    maxTokens: 1024,
    temperature: 0,
    label: "reflect",
  })
  return parseReflectionNotes(reply)
}

// ── Evidence ────────────────────────────────────────────────────────────────

interface DraftEvidenceRow {
  cell_id: string
  text: string
}
interface DirectionRow {
  body: string
}
interface DecisionRow {
  reason: string
  resolution: unknown
}

/** The instant everything in this reflection's evidence must be newer than.
 *  A run that never reflected reflects over its whole life — exactly once. */
export function reflectionWatermark(run: ContextualRun): string {
  return run.reflectedAt ?? run.createdAt
}

export async function gatherReflectionEvidence(
  db: AquillaDb,
  run: ContextualRun,
): Promise<ReflectionEvidence> {
  const since = reflectionWatermark(run)
  const [draftRows, directionRows, decisionRows] = await Promise.all([
    db
      .prepare(
        `SELECT cell_id, text FROM contextual_drafts
          WHERE project_id = ? AND run_id = ? AND created_at > ?::timestamptz
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(run.projectId, run.id, since, MAX_REFLECTION_DRAFTS)
      .all<DraftEvidenceRow>(),
    db
      .prepare(
        `SELECT body FROM contextual_steering
          WHERE project_id = ? AND run_id = ? AND kind = 'direction'
            AND consumed_at IS NOT NULL AND consumed_at > ?::timestamptz
          ORDER BY consumed_at DESC
          LIMIT ?`,
      )
      .bind(run.projectId, run.id, since, MAX_REFLECTION_DIRECTIONS)
      .all<DirectionRow>(),
    db
      .prepare(
        `SELECT reason, resolution FROM contextual_decisions
          WHERE project_id = ? AND run_id = ? AND status = 'resolved'
            AND resolved_at > ?::timestamptz
          ORDER BY resolved_at DESC
          LIMIT ?`,
      )
      .bind(run.projectId, run.id, since, MAX_REFLECTION_DECISIONS)
      .all<DecisionRow>(),
  ])
  const answeredDecisions: { question: string; answer: string }[] = []
  for (const row of decisionRows.results) {
    const resolution = parseResolution(row.resolution)
    if (!resolution) continue
    answeredDecisions.push({ question: row.reason, answer: resolution })
  }
  return {
    drafts: draftRows.results.map((row) => ({ label: row.cell_id, text: row.text })),
    directions: directionRows.results.map((row) => row.body),
    answeredDecisions,
  }
}

function parseResolution(value: unknown): string | null {
  let obj: unknown = value
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value) as unknown
    } catch {
      // A resolution nobody can read is not an answer to learn from.
      return null
    }
  }
  if (!obj || typeof obj !== "object") return null
  const record = obj as Record<string, unknown>
  if (record.kind !== "answered") return null
  return typeof record.answer === "string" && record.answer.trim() ? record.answer.trim() : null
}

export async function loadReflectionKnown(
  db: AquillaDb,
  run: ContextualRun,
): Promise<{ known: ReflectionKnown; takenPaths: Set<string> }> {
  const [ctx, approved, proposed] = await Promise.all([
    loadProjectContext(db, run.projectId),
    listMemories(db, run.projectId, "approved"),
    listMemories(db, run.projectId, "proposed"),
  ])
  const terms = ctx.concepts
    .slice(0, MAX_REFLECTION_KNOWN)
    .map((concept) => {
      const renderings = concept.renderings
        .map((rendering) => `${rendering.rendering} (${rendering.status})`)
        .join(", ")
      return renderings ? `${concept.sourceTerm} → ${renderings}` : concept.sourceTerm
    })
  const targetLanguage = run.targetLang || ctx.targetLanguage
  return {
    known: {
      ...(targetLanguage ? { targetLanguage } : {}),
      memories: approved
        .slice(0, MAX_REFLECTION_KNOWN)
        .map((memory) => ({ path: memory.path, content: memory.content })),
      rules: ctx.authoredRules
        .slice(0, MAX_REFLECTION_KNOWN)
        .map((rule) => (rule.description ? `${rule.name}: ${rule.description}` : rule.name)),
      terms,
    },
    // A path already carrying an approved or still-pending proposal is not
    // news. Dropping it here (not only in the prompt) is what makes
    // "don't re-propose what's approved" a guarantee rather than a request.
    takenPaths: new Set([...approved, ...proposed].map((memory) => memory.path)),
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface ReflectAtParkDeps {
  db: AquillaDb
  run: ContextualRun
  llm: LlmCall
}

/**
 * Reflect on a parking run and stage the notes for human review. Returns how
 * many proposals landed (0 when the run is below the span gate, when the model
 * had nothing to say, or when every note duplicated something already known).
 *
 * A model failure propagates: the tick is the layer that decides a park must
 * stand regardless, and it records the failure on the run's activity. Swallowing
 * it here would make a run that stopped learning indistinguishable from one
 * that had nothing to say.
 */
export async function reflectAtPark(deps: ReflectAtParkDeps): Promise<number> {
  const { db, run } = deps
  if (!shouldReflect(run)) return 0
  const [evidence, { known, takenPaths }] = await Promise.all([
    gatherReflectionEvidence(db, run),
    loadReflectionKnown(db, run),
  ])
  if (evidence.drafts.length === 0) {
    // Nothing observable to abstract from. Still a completed reflection: move
    // the watermark so the next park looks at new work, not this gap again.
    await markRunReflected(db, run.id)
    return 0
  }
  const notes = await reflectOnRun({ llm: deps.llm, evidence, known })
  let staged = 0
  for (const note of notes) {
    if (takenPaths.has(note.path)) continue
    const result = await createProposal(db, {
      projectId: run.projectId,
      path: note.path,
      content: note.content,
      rationale: note.rationale,
      provenance: { runId: run.id },
      createdBy: run.initiatedBy,
    })
    if (result.status !== "ok") {
      // Validation is the same gate a chat proposal passes (size, secrets,
      // path shape). A refusal drops that note and keeps the others.
      console.warn(`[contextual] reflection note rejected for run ${run.id}: ${result.message}`)
      continue
    }
    takenPaths.add(note.path)
    staged += 1
  }
  await markRunReflected(db, run.id)
  return staged
}
