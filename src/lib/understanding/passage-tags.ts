// Document-understanding tags on passage nodes (AQU-657, capability 3 — slice 1).
//
// AQU-1386 scores every seam; AQU-1387 turns those scores into the structural
// spine (units → passages → sections). That spine says WHERE a document divides
// and nothing about WHAT is inside each division. This module adds the missing
// half: for each passage node, who is involved, whether it opens a new scene,
// whether it is speech or narration, and which other passages it leans on.
//
// Those four tags are exactly the tree the ticket's 2026-09-24 plan asks for
// ("a `choice` of participants present, `scene_change`, `speech_vs_narration`,
// `refers_to_passage_X"), and they exist to be READ: retrieval and few-shot
// selection pick examples by participant and discourse mode, and the edit
// propagation slice (capability 2) shortlists candidates by `refersTo` before
// spending an LLM call on a rewrite.
//
// Constraints for anything added here — SAME contract as
// ../completion/seams.ts, because auth-worker's tag route imports this module so
// the combine rule that decides a tag server-side is byte-identical to the one
// the SPA re-derives from cached answers:
//   - NO `@/` path aliases, transitively (worker tsconfigs have no path mapping).
//   - NO DOM, no `import.meta.env`, no storage access, no i18n.
//   - Pure functions only.
//
// Why every tag is asked as its own narrow yes/no, and combined in code here:
// Jev's published guidance (and the reason ../completion/seams.ts looks the way
// it does) is that one broad question scores far worse than several atomic ones
// combined deterministically. "Describe this passage" is the broad formulation.
// "Is Nicodemus present in this passage?" is not.
//
// Why there is no `choice` question even though the plan names one: the only
// upstream answer shapes this codebase has actually exercised against the live
// endpoint are `noul` (a calibrated probability) and `score` (an ordinal). A
// participant set is a MULTI-valued answer anyway — two people in one passage is
// the normal case, not an edge case — so it is asked as one bounded `noul` per
// candidate, which also gives each participant its own confidence instead of one
// shared number for the whole set.

import { parseVerseRef } from "../import/passages"

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

/** The two tags asked once per node. The other two are asked once per candidate. */
export type NodeTagKey = "scene_change" | "speech"

export interface NodeTagQuestion {
  key: NodeTagKey
  /** Verbatim question text sent to the decision model. */
  question: string
}

export const NODE_TAG_QUESTIONS: readonly NodeTagQuestion[] = [
  {
    key: "scene_change",
    question:
      "Does THIS PASSAGE begin a new scene — a change of time, place, or cast — "
      + "rather than continuing the scene of the PREVIOUS PASSAGE?",
  },
  {
    key: "speech",
    question:
      "Is THIS PASSAGE mostly direct speech (what someone says, quoted) rather "
      + "than narration about what happens?",
  },
]

export const PARTICIPANT_QUESTION =
  "Does PARTICIPANT take part in THIS PASSAGE — acting, speaking, or being spoken to — "
  + "rather than merely being mentioned in passing?"

export const REFERS_TO_QUESTION =
  "Does THIS PASSAGE depend on CANDIDATE PASSAGE for its meaning — the same episode, "
  + "the same speech, or an explicit reference back to it?"

/**
 * Bound on candidates per node, per kind.
 *
 * Both lists are shortlists, not inventories: participants come from a
 * per-book cast an LLM extracts once (not this module's job), and related
 * passages come from `shortlistRelated` or from retrieval. Asking about 200
 * candidates would cost more than the LLM pass the tags exist to avoid, and a
 * shortlist that long is not a shortlist.
 */
export const MAX_PARTICIPANT_CANDIDATES = 12
export const MAX_RELATED_CANDIDATES = 8

// ---------------------------------------------------------------------------
// Nodes and candidates
// ---------------------------------------------------------------------------

/**
 * One passage node as the model sees it. `text` is the passage's source text,
 * already concatenated by the caller — tags are a property of the passage, not
 * of its individual cells, which is the whole reason this layer sits above the
 * seam scorer rather than beside it.
 */
export interface PassageTagNode {
  /** `ImportPassage.key` — stable within a file and across deterministic re-imports. */
  key: string
  /** Human label from the spine (verse range, or opening words). */
  label: string
  text: string
  startRef?: string | null
  endRef?: string | null
}

/** A candidate related passage: a node elsewhere in the project that might be
 *  the one THIS node leans on. */
export interface RelatedCandidate {
  key: string
  label: string
  text: string
}

export interface TagCandidates {
  /** Names from the book's extracted cast, in the order they should be asked. */
  participants: readonly string[]
  related: readonly RelatedCandidate[]
}

export const EMPTY_CANDIDATES: TagCandidates = { participants: [], related: [] }

// ---------------------------------------------------------------------------
// Answers + thresholds
// ---------------------------------------------------------------------------

/**
 * One node's answers as returned by the decision model. Every field is
 * optional, and the two maps are keyed by candidate index rather than by name:
 * a name is user data that can contain anything, and an index cannot collide
 * with a wire key.
 */
export interface PassageTagAnswers {
  scene_change?: number
  speech?: number
  /** `participants[i]` answers about `candidates.participants[i]`. */
  participants?: (number | undefined)[]
  /** `related[i]` answers about `candidates.related[i]`. */
  related?: (number | undefined)[]
}

export interface TagThresholds {
  /** Probability at or above which a tag is asserted true. */
  assert: number
  /**
   * Minimum decision confidence (0 = coin flip, 1 = certain) below which the
   * model's answer is discarded in favour of the deterministic heuristic. Same
   * gate, same reasoning, and deliberately the same default as
   * DEFAULT_SEAM_THRESHOLDS: a calibrated model that still votes while
   * undecided is worse than a rule you can read.
   */
  confidence: number
}

/**
 * Starting thresholds. PROVISIONAL — `scripts/passage-tags-eval.ts` is the
 * instrument that replaces them with numbers justified by labelled data, and
 * the kill switch in ./passage-tags-flag.ts stays off until it has run.
 */
export const DEFAULT_TAG_THRESHOLDS: TagThresholds = {
  assert: 0.5,
  confidence: 0.4,
}

/** How a tag was ultimately decided — surfaced so the eval can score model and
 *  heuristic separately instead of scoring the blend. */
export type TagDecidedBy = "model" | "heuristic"

export interface BooleanTag {
  value: boolean
  /** Probability behind `value`. Heuristic decisions report 1 or 0: the
   *  heuristic is deterministic, and pretending otherwise would let it win a
   *  confidence tie-break against a real 0.51. */
  probability: number
  confidence: number
  decidedBy: TagDecidedBy
}

export interface ParticipantTag extends BooleanTag {
  name: string
}

export interface RelatedTag extends BooleanTag {
  /** The candidate node's key. */
  key: string
}

/** Everything known about one passage node. The "tree" is these, keyed by node,
 *  layered over the spine's parent/child ordering — no second hierarchy. */
export interface PassageTags {
  nodeKey: string
  /** Candidates the model (or the heuristic) said are present, in candidate order. */
  participants: ParticipantTag[]
  sceneChange: BooleanTag
  speech: BooleanTag
  refersTo: RelatedTag[]
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Bump when a question's wording, the candidate contract, or the combine rule
 * changes. It is part of every cache key, so a question change invalidates
 * cached answers instead of silently mixing answers to two different questions
 * in one tree.
 */
export const TAG_SET_VERSION = 1

/** FNV-1a (32-bit), hex. Not a hash for security — a short, stable digest so a
 *  key stays bounded no matter how many cells or candidates a node covers. */
function digest(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * A node's cache key: its passage key, the source events it covers, and the
 * candidates it was asked about.
 *
 * Content-addressed for the same reason `seamKey` is — editing one source cell
 * mints a new event id, so the key of the passage containing it stops matching
 * and every other node in the file still hits. The candidate digest is in the
 * key because an answer to "is Nicodemus present?" is not an answer about a
 * different cast: growing the cast re-asks, rather than reporting a short
 * answer set as complete.
 *
 * Returns null when any covered cell has no source event yet (created locally,
 * not yet acked). An unkeyable node is simply not cacheable — callers fall back
 * to the heuristic rather than inventing a key that could collide.
 */
export function passageTagKey(
  nodeKey: string,
  sourceEventIds: readonly (string | null | undefined)[],
  candidates: TagCandidates = EMPTY_CANDIDATES,
): string | null {
  if (sourceEventIds.length === 0) return null
  if (sourceEventIds.some((id) => !id)) return null
  const cast = [...candidates.participants].join("\u0000")
  const related = candidates.related.map((c) => c.key).join("\u0000")
  return `v${TAG_SET_VERSION}:${nodeKey}:${digest(sourceEventIds.join("\u0000"))}`
    + `:${digest(`${cast}\u0001${related}`)}`
}

// ---------------------------------------------------------------------------
// The deterministic fallbacks
// ---------------------------------------------------------------------------

/**
 * Letters either side of a name must not be letters — so "Mary" matches in
 * "Mary said" and in "«Mary»", and does not match inside "Marys" or "Rosemary".
 * Built per name rather than with a word-boundary class because `\b` is
 * ASCII-only and most of the cast in a translation project is not.
 */
function mentions(text: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|\\P{L})${escaped}(\\P{L}|$)`, "iu").test(text)
}

/**
 * Participant heuristic: the name appears in the passage.
 *
 * Crude on purpose, and crude in a known direction — it cannot tell a
 * participant from a mention ("they left Jerusalem" does not make Jerusalem a
 * participant) and it misses every pronoun reference. That is precisely the gap
 * the model is being measured against in the eval, and it is still far better
 * than no cast at all.
 */
export function heuristicParticipants(
  text: string,
  candidates: readonly string[],
): string[] {
  return candidates.filter((name) => mentions(text, name))
}

/** Opening and closing quotation marks across the scripts this app imports,
 *  including the CJK corner brackets and the guillemets French and Russian
 *  Bibles use for speech. */
const QUOTE_OPEN = /[«“„‟「『‘‛"']/u
const QUOTE_CLOSE = /[»”‟」』’"']/u

/**
 * Speech heuristic: at least `SPEECH_SHARE` of the passage's characters sit
 * inside quotation marks.
 *
 * Counting the quoted SHARE rather than the presence of a quote is what keeps a
 * narrative passage with one quoted line from reading as speech. Unpaired marks
 * (a passage that opens a quotation and continues past its end) count to the end
 * of the passage, which is the right reading of a split speech.
 */
export const SPEECH_SHARE = 0.5

export function heuristicSpeech(text: string): boolean {
  if (!text) return false
  let quoted = 0
  let open = false
  for (const char of text) {
    if (!open && QUOTE_OPEN.test(char)) {
      open = true
      continue
    }
    if (open && QUOTE_CLOSE.test(char)) {
      open = false
      continue
    }
    if (open) quoted += 1
  }
  return quoted / [...text].length >= SPEECH_SHARE
}

/**
 * Scene-change heuristic: the passage opens in a different chapter (or book)
 * from where the previous passage ended.
 *
 * Only an address change counts. With no refs to compare — a workbook, a media
 * transcript, the first passage of a file — the answer is FALSE rather than
 * unknown-as-true: asserting a scene change we cannot see would fragment a
 * document that may well be one continuous scene, and a missing scene break
 * costs retrieval a little precision while a spurious one costs it a whole
 * passage's context.
 */
export function heuristicSceneChange(
  node: Pick<PassageTagNode, "startRef">,
  previous: Pick<PassageTagNode, "endRef"> | null | undefined,
): boolean {
  const start = parseVerseRef(node.startRef)
  const end = parseVerseRef(previous?.endRef)
  if (!start || !end) return false
  return start.book !== end.book || start.chapter !== end.chapter
}

/** Tokens shorter than this carry no evidence of a shared episode — every text
 *  shares "and", "the", "he". */
const MIN_OVERLAP_TOKEN_CHARS = 4

function contentTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= MIN_OVERLAP_TOKEN_CHARS) out.add(token)
  }
  return out
}

/**
 * Lexical overlap (Jaccard) between two passages' content tokens.
 *
 * This is both the `refersTo` heuristic and the shortlister that proposes the
 * candidates the model is then asked about — which is the division of labour the
 * ticket's plan describes: code gathers candidates cheaply, Jev decides, and
 * only the survivors ever reach an LLM.
 */
export function lexicalOverlap(a: string, b: string): number {
  const left = contentTokens(a)
  const right = contentTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared += 1
  }
  return shared / (left.size + right.size - shared)
}

/**
 * Overlap at which the heuristic claims a reference — deliberately high enough
 * that it only fires on near-duplicates.
 *
 * MEASURED, not guessed. On scripts/fixtures/passage-tags-eval.json, overlap
 * does not separate real references from unrelated passages at all: the two
 * labelled references score 0.088 and 0.095 while unrelated pairs in the same
 * chapter score up to 0.167, so NO threshold recovers them and a low one simply
 * asserts the wrong pairs. That is the finding that justifies asking a model
 * instead of writing a better regex — which is the ticket's own framing of
 * capability 2.
 *
 * So the heuristic's job here is narrowed to what overlap can actually carry: a
 * near-duplicate guard, with the model (or nothing) deciding the rest. Erring
 * toward silence is the cheap direction — a false reference spends an LLM
 * rewrite on an unrelated passage, a missed one spends nothing.
 *
 * Overlap IS used for what it is good at: `shortlistRelated` ranks candidates by
 * it, and on the same fixture that shortlist proposed 100% of the labelled
 * references.
 */
export const REFERS_TO_OVERLAP = 0.35

export function heuristicRefersTo(text: string, candidate: RelatedCandidate): boolean {
  return lexicalOverlap(text, candidate.text) >= REFERS_TO_OVERLAP
}

/**
 * Candidate related passages for one node: the `limit` most lexically similar
 * other nodes, strongest first, excluding the node itself and anything with no
 * overlap at all.
 *
 * Deterministic, so the eval and production shortlist identically, and so a
 * cached tag set can be re-keyed without a retrieval index being available.
 */
export function shortlistRelated(
  node: PassageTagNode,
  others: readonly PassageTagNode[],
  limit: number = MAX_RELATED_CANDIDATES,
): RelatedCandidate[] {
  if (limit <= 0) return []
  return others
    .filter((other) => other.key !== node.key)
    .map((other) => ({ other, overlap: lexicalOverlap(node.text, other.text) }))
    .filter((scored) => scored.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.other.key.localeCompare(b.other.key))
    .slice(0, limit)
    .map(({ other }) => ({ key: other.key, label: other.label, text: other.text }))
}

// ---------------------------------------------------------------------------
// The combine rule
// ---------------------------------------------------------------------------

/** Distance from a coin flip, normalized to [0,1]. Same function as
 *  ../completion/seams.ts: `noul` answers carry no confidence field, so
 *  certainty IS the probability's distance off 0.5. */
function certainty(p: number): number {
  return Math.min(1, Math.max(0, Math.abs(p - 0.5) * 2))
}

function isProbability(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
}

function heuristicTag(value: boolean): BooleanTag {
  return { value, probability: value ? 1 : 0, confidence: 1, decidedBy: "heuristic" }
}

/**
 * One tag, from one probability and the heuristic that stands in for it.
 *
 * Per-tag rather than per-node: a model that is certain about speech and
 * undecided about the cast should keep its speech answer. Deciding the whole
 * node by its weakest question would throw away answers that are good.
 */
function combineTag(
  probability: number | undefined,
  fallback: boolean,
  thresholds: TagThresholds,
): BooleanTag {
  if (!isProbability(probability)) return heuristicTag(fallback)
  const confidence = certainty(probability)
  if (confidence < thresholds.confidence) return heuristicTag(fallback)
  return {
    value: probability >= thresholds.assert,
    probability,
    confidence,
    decidedBy: "model",
  }
}

/**
 * Combine one node's answers into its tags.
 *
 * Takes the node, its predecessor (for `scene_change`, which is relative by
 * definition) and the candidates it was asked about, so the same call site
 * produces the model-backed tags and — with `answers` null — the heuristic
 * baseline the eval scores against. The route and the SPA both call THIS
 * function; there is no second combine rule anywhere.
 */
export function combinePassageTags(
  node: PassageTagNode,
  previous: PassageTagNode | null | undefined,
  candidates: TagCandidates,
  answers: PassageTagAnswers | null | undefined,
  thresholds: TagThresholds = DEFAULT_TAG_THRESHOLDS,
): PassageTags {
  const present = new Set(heuristicParticipants(node.text, candidates.participants))

  const participants = candidates.participants.map((name, index) => ({
    name,
    ...combineTag(answers?.participants?.[index], present.has(name), thresholds),
  }))

  const refersTo = candidates.related.map((candidate, index) => ({
    key: candidate.key,
    ...combineTag(
      answers?.related?.[index],
      heuristicRefersTo(node.text, candidate),
      thresholds,
    ),
  }))

  return {
    nodeKey: node.key,
    participants,
    sceneChange: combineTag(
      answers?.scene_change,
      heuristicSceneChange(node, previous),
      thresholds,
    ),
    speech: combineTag(answers?.speech, heuristicSpeech(node.text), thresholds),
    refersTo,
  }
}

/**
 * Structural check that a value is a tag set.
 *
 * Lives here, beside the type, because it is the CONTRACT between the route that
 * produces tags and the two consumers that read them — ./passage-tag-client.ts
 * over the wire, and auth-worker's route test, which asserts its own response
 * passes this. One guard, so a field added to PassageTags cannot be accepted by
 * one side and silently dropped by the other.
 */
export function isPassageTags(value: unknown): value is PassageTags {
  if (!value || typeof value !== "object") return false
  const tags = value as Record<string, unknown>
  return (
    typeof tags.nodeKey === "string"
    && Array.isArray(tags.participants)
    && Array.isArray(tags.refersTo)
    && isBooleanTag(tags.sceneChange)
    && isBooleanTag(tags.speech)
  )
}

function isBooleanTag(value: unknown): value is BooleanTag {
  if (!value || typeof value !== "object") return false
  const tag = value as Record<string, unknown>
  return (
    typeof tag.value === "boolean"
    && typeof tag.probability === "number"
    && typeof tag.confidence === "number"
    && (tag.decidedBy === "model" || tag.decidedBy === "heuristic")
  )
}

/** The asserted cast of a node — what retrieval and few-shot selection read. */
export function taggedParticipants(tags: PassageTags): string[] {
  return tags.participants.filter((p) => p.value).map((p) => p.name)
}

/** The nodes this node leans on, strongest first — the shortlist capability 2
 *  hands to an LLM for a propagated rewrite. */
export function taggedReferences(tags: PassageTags): string[] {
  return tags.refersTo
    .filter((r) => r.value)
    .sort((a, b) => b.probability - a.probability || a.key.localeCompare(b.key))
    .map((r) => r.key)
}
