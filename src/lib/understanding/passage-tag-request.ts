// Jev (TypeSafe System One) wire format for passage tags (AQU-657, slice 1).
//
// Split from ./passage-tags.ts for the same reason ../completion/seam-request.ts
// is split from ../completion/seams.ts: the COMBINE RULE is product logic we
// argue about, this is an upstream contract we merely conform to.
//
// Both auth-worker's /api/v1/ai/passage-tags route and
// scripts/passage-tags-eval.ts build their requests here — an eval whose prompts
// differ from production's measures a system nobody ships.
//
// Same alias-free / DOM-free contract as ./passage-tags.ts.
//
// Upstream reference: https://docs.typesafe.ai/api.md
//   POST { model, state, questions } → { model, answers, usage }
//   - a `noul` question answers `{ type: "noul", noul: <p(yes)> }` and carries NO
//     confidence field, which is why ./passage-tags.ts derives certainty from the
//     probability's distance off 0.5.
//
// Every question here is a `noul`. Tags are properties that either hold or do
// not; none of them is an ordinal, so none of them is a `score`.

import {
  MAX_PARTICIPANT_CANDIDATES,
  MAX_RELATED_CANDIDATES,
  NODE_TAG_QUESTIONS,
  PARTICIPANT_QUESTION,
  REFERS_TO_QUESTION,
  type PassageTagAnswers,
  type PassageTagNode,
  type TagCandidates,
} from "./passage-tags"

/**
 * PINNED, never an alias — same model and same reasoning as
 * ../completion/seam-request.ts. `jev-latest` would silently re-point the
 * classifier at a model the shadow eval never scored, invalidating
 * DEFAULT_TAG_THRESHOLDS without anything failing.
 */
export const JEV_MODEL = "typesafe/jev-1.13"

/** OpenRouter fronts the TypeSafe evaluation endpoint, so the existing
 *  server-side OPENROUTER_API_KEY is the only credential needed. */
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"

/**
 * Upper bound on nodes per request.
 *
 * Lower than the seam scorer's 40 because a node carries far more: two tag
 * questions plus up to MAX_PARTICIPANT_CANDIDATES + MAX_RELATED_CANDIDATES
 * candidate questions, and a passage's full text rather than one cell's. Ten
 * nodes is a chapter's worth of passages — the unit a caller tags at once.
 */
export const MAX_NODES_PER_REQUEST = 10

/**
 * Hard ceiling on questions in one call, checked after the per-node fan-out.
 * Batching is cheap (TypeSafe's own study: 13 questions in one call, 12x
 * cheaper and 10x faster than 13 calls) but a request that fails takes every
 * question with it, so the fan-out stays bounded on BOTH axes.
 */
export const MAX_QUESTIONS_PER_REQUEST =
  MAX_NODES_PER_REQUEST * (2 + MAX_PARTICIPANT_CANDIDATES + MAX_RELATED_CANDIDATES)

export interface JevNoulQuestion {
  type: "noul"
  instructions: Record<string, unknown>
  criteria?: { true: string; false: string }
}

export interface JevTagRequest {
  model: string
  state: {
    passages: { index: number; label: string; range?: string; text: string }[]
    /** Candidate related passages, deduplicated across the window — a candidate
     *  named by three nodes is sent once. */
    candidates: { label: string; text: string }[]
  }
  questions: Record<string, JevNoulQuestion>
}

const NODE_CRITERIA: Record<(typeof NODE_TAG_QUESTIONS)[number]["key"], {
  true: string
  false: string
}> = {
  scene_change: {
    true: "The time, place, or cast changes at the start of THIS PASSAGE.",
    false: "THIS PASSAGE continues the scene the PREVIOUS PASSAGE was in.",
  },
  speech: {
    true: "Most of THIS PASSAGE is words someone speaks.",
    false: "Most of THIS PASSAGE narrates or explains.",
  },
}

const PARTICIPANT_CRITERIA = {
  true: "PARTICIPANT acts, speaks, or is addressed in THIS PASSAGE.",
  false: "PARTICIPANT is absent, or named only in passing.",
}

const RELATED_CRITERIA = {
  true: "THIS PASSAGE and CANDIDATE PASSAGE are the same episode, or THIS PASSAGE refers back to it.",
  false: "They are independent passages that merely share vocabulary.",
}

function passageLabel(index: number): string {
  return `passage ${index}`
}

function candidateLabel(index: number): string {
  return `candidate ${index}`
}

/** Question id for node `i`. Answers come back under the same ids, so this and
 *  the two below are the only places the wire-key ↔ index mapping is defined. */
export function nodeQuestionId(nodeIndex: number, key: string): string {
  return `n${nodeIndex}_${key}`
}

export function participantQuestionId(nodeIndex: number, candidateIndex: number): string {
  return `n${nodeIndex}_p${candidateIndex}`
}

export function relatedQuestionId(nodeIndex: number, candidateIndex: number): string {
  return `n${nodeIndex}_r${candidateIndex}`
}

/** A node paired with the candidates it is asked about. Candidates are per-node
 *  because a shortlist is: the cast of Luke 5 is not the cast of Luke 6. */
export interface TaggedNodeRequest {
  node: PassageTagNode
  candidates: TagCandidates
}

function range(node: PassageTagNode): string | undefined {
  if (node.startRef && node.endRef) return `${node.startRef}–${node.endRef}`
  return node.startRef ?? node.endRef ?? undefined
}

/**
 * Build ONE request covering every node in a window.
 *
 * The whole window goes into `state` and each question names its passage by the
 * label used there, so a node's neighbours are visible to the model for free —
 * which is what makes `scene_change` answerable at all: it is a question about
 * two adjacent passages, and the previous one is already in the state.
 *
 * Throws on an oversize window rather than silently truncating: a caller that
 * loses half its nodes to a cap it did not know about ships a tree that is half
 * model-tagged and half lexically guessed, with nothing saying which half.
 */
export function buildPassageTagRequest(
  nodes: readonly TaggedNodeRequest[],
  model: string = JEV_MODEL,
): JevTagRequest {
  if (nodes.length > MAX_NODES_PER_REQUEST) {
    throw new RangeError(
      `tag window of ${nodes.length} exceeds MAX_NODES_PER_REQUEST (${MAX_NODES_PER_REQUEST})`,
    )
  }

  // Candidate texts are deduplicated by key across the window and referenced by
  // label, so three nodes asking about the same passage send its text once.
  const candidateIndexByKey = new Map<string, number>()
  const candidates: { label: string; text: string }[] = []
  for (const { candidates: c } of nodes) {
    for (const candidate of c.related.slice(0, MAX_RELATED_CANDIDATES)) {
      if (candidateIndexByKey.has(candidate.key)) continue
      candidateIndexByKey.set(candidate.key, candidates.length)
      candidates.push({ label: candidate.label, text: candidate.text })
    }
  }

  const state: JevTagRequest["state"] = {
    passages: nodes.map(({ node }, index) => {
      const refRange = range(node)
      return {
        index,
        label: node.label,
        ...(refRange ? { range: refRange } : {}),
        text: node.text,
      }
    }),
    candidates,
  }

  const questions: Record<string, JevNoulQuestion> = {}
  nodes.forEach(({ node: _node, candidates: nodeCandidates }, index) => {
    const self = passageLabel(index)
    // The first node of a window has no predecessor IN THE WINDOW. Naming the
    // window's own previous passage (rather than the file's) keeps the question
    // answerable from `state` alone; a window boundary therefore asks about a
    // scene change the model can see, or not at all.
    const previous = index > 0 ? passageLabel(index - 1) : null

    for (const question of NODE_TAG_QUESTIONS) {
      if (question.key === "scene_change" && !previous) continue
      questions[nodeQuestionId(index, question.key)] = {
        type: "noul",
        instructions: {
          this_passage: self,
          ...(previous ? { previous_passage: previous } : {}),
          question: question.question,
        },
        criteria: NODE_CRITERIA[question.key],
      }
    }

    nodeCandidates.participants
      .slice(0, MAX_PARTICIPANT_CANDIDATES)
      .forEach((name, candidateIndex) => {
        questions[participantQuestionId(index, candidateIndex)] = {
          type: "noul",
          instructions: {
            this_passage: self,
            participant: name,
            question: PARTICIPANT_QUESTION,
          },
          criteria: PARTICIPANT_CRITERIA,
        }
      })

    nodeCandidates.related
      .slice(0, MAX_RELATED_CANDIDATES)
      .forEach((candidate, candidateIndex) => {
        const target = candidateIndexByKey.get(candidate.key)
        if (target === undefined) return
        questions[relatedQuestionId(index, candidateIndex)] = {
          type: "noul",
          instructions: {
            this_passage: self,
            candidate_passage: candidateLabel(target),
            question: REFERS_TO_QUESTION,
          },
          criteria: RELATED_CRITERIA,
        }
      })
  })

  const count = Object.keys(questions).length
  if (count > MAX_QUESTIONS_PER_REQUEST) {
    throw new RangeError(
      `tag window of ${count} questions exceeds MAX_QUESTIONS_PER_REQUEST (${MAX_QUESTIONS_PER_REQUEST})`,
    )
  }

  return { model, state, questions }
}

/**
 * The windows one document's nodes are asked in, as `[from, to)` index ranges.
 *
 * Every window after the first REOPENS on the previous window's last node, so
 * each node that has a predecessor is asked alongside it — without that overlap
 * the first node of every window would be asked a `scene_change` question about
 * a passage it cannot see, and `buildPassageTagRequest` would (correctly) decline
 * to ask at all. One node of overlap, never two: a re-asked node costs a
 * question, and a gap costs a tag.
 *
 * Lives here, beside the request builder, because the store and
 * scripts/passage-tags-eval.ts must window identically — an eval that windows
 * differently from production measures a different system.
 */
export function tagWindows(nodeCount: number): { from: number; to: number }[] {
  const windows: { from: number; to: number }[] = []
  let cursor = 0
  while (cursor < nodeCount) {
    const from = cursor === 0 ? 0 : cursor - 1
    const to = Math.min(nodeCount, from + MAX_NODES_PER_REQUEST)
    windows.push({ from, to })
    if (to <= cursor) break
    cursor = to
  }
  return windows
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function noulValue(answer: unknown): number | undefined {
  if (!answer || typeof answer !== "object") return undefined
  const value = (answer as { noul?: unknown }).noul
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Demux one response into per-node answers, in window order.
 *
 * Every field is optional and every node may come back null. A node whose
 * answers are missing or malformed is NOT an error: `combinePassageTags` falls
 * back to the lexical heuristic for exactly that node and the rest of the tree
 * keeps its model answers. A partial response degrading one passage beats a
 * throw that leaves a whole file untagged.
 */
export function parsePassageTagAnswers(
  body: unknown,
  nodes: readonly TaggedNodeRequest[],
): (PassageTagAnswers | null)[] {
  const answers =
    body && typeof body === "object"
      ? ((body as { answers?: unknown }).answers as Record<string, unknown> | undefined)
      : undefined

  return nodes.map(({ candidates }, index) => {
    if (!answers || typeof answers !== "object") return null

    const node: PassageTagAnswers = {}
    let any = false

    for (const question of NODE_TAG_QUESTIONS) {
      const value = noulValue(answers[nodeQuestionId(index, question.key)])
      if (value === undefined) continue
      node[question.key] = value
      any = true
    }

    const participants = candidates.participants
      .slice(0, MAX_PARTICIPANT_CANDIDATES)
      .map((_, candidateIndex) =>
        noulValue(answers[participantQuestionId(index, candidateIndex)]))
    if (participants.some((value) => value !== undefined)) {
      node.participants = participants
      any = true
    }

    const related = candidates.related
      .slice(0, MAX_RELATED_CANDIDATES)
      .map((_, candidateIndex) => noulValue(answers[relatedQuestionId(index, candidateIndex)]))
    if (related.some((value) => value !== undefined)) {
      node.related = related
      any = true
    }

    return any ? node : null
  })
}
