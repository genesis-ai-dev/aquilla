// POST /api/v1/ai/passage-tags/classify — document-understanding tags on the
// passage spine (AQU-657, capability 3 — slice 1).
//
// A PASSAGE NODE is one entry of the spine AQU-1387 builds. The client sends a
// window of nodes in document order, each with the candidate cast and candidate
// related passages it should be asked about; this route asks Jev one narrow
// question per candidate in ONE batched call, combines the answers with the SAME
// rule the client uses, and returns the tags per node.
//
// Why the call lives here and not in the browser: the key stays server-side,
// exactly like /api/v1/chat and /api/v1/ai/seams. The client never sees a Jev
// credential.
//
// Why this route does NOT run runAiGuard: identical to the seam route's reason.
// runAiGuard enforces the DRAFTING model allowlist; `typesafe/jev-1.13` is
// pinned in code, never user-supplied, returns probabilities rather than text,
// and costs about $0.00003 per call. Adding it to that allowlist to satisfy a
// guard would make it selectable as a translation model, which it is not. What
// this route needs is volumetric control, so it takes the same per-user
// sliding-window cap primitive the chat proxy and the seam route use.
//
// Failure is never fatal. Upstream down, unauthenticated, malformed, or merely
// unconfident → the route answers 200 with lexical/heuristic tags and says so in
// each tag's `decidedBy`. Tagging enriches retrieval and shortlisting; nothing
// blocks on it, which is also what makes it safe to compute in the background.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { ROLE } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../db/shared/rate-limit"
import {
  DEFAULT_TAG_THRESHOLDS,
  MAX_PARTICIPANT_CANDIDATES,
  MAX_RELATED_CANDIDATES,
  combinePassageTags,
  type PassageTagNode,
  type PassageTags,
  type TagCandidates,
} from "../../../src/lib/understanding/passage-tags"
import {
  JEV_DECISIONS_URL,
  JEV_MODEL,
  MAX_NODES_PER_REQUEST,
  buildPassageTagRequest,
  parsePassageTagAnswers,
  type TaggedNodeRequest,
} from "../../../src/lib/understanding/passage-tag-request"

const aiPassageTags = new Hono<{ Bindings: Env; Variables: Variables }>()

/** Tagging reads source text the caller can already read, so the gate is the
 *  same as the seam route's: anyone who can see the project's cells. */
const MIN_TAG_ROLE = ROLE.VIEWER

/**
 * Per-user sliding-window cap, same primitive and window as the chat proxy's.
 *
 * Lower than the seam route's 400 because a node is a bigger unit than a seam:
 * a whole book is a few hundred passages against tens of thousands of seams, and
 * tags are cached per node, so a translator tagging every file they open in a
 * sitting stays far under this while a scripted loop against the shared key does
 * not.
 */
const TAGS_MAX_PER_USER_PER_WINDOW = 120

/** Upstream latency budget. A batched decision call is 150–500ms in the normal
 *  case; past this the heuristic is simply a better deal than waiting. */
const TAG_TIMEOUT_MS = 15_000

/** A passage is many cells of prose, so the per-node cap is well above the seam
 *  route's per-cell 4k — but still a cap: the model gets the passage, not a book. */
const MAX_NODE_CHARS = 12_000
const MAX_CANDIDATE_CHARS = 4_000

const candidateSchema = z.object({
  key: z.string().trim().min(1).max(255),
  label: z.string().trim().max(255),
  text: z.string().max(MAX_CANDIDATE_CHARS),
})

const nodeSchema = z.object({
  key: z.string().trim().min(1).max(255),
  label: z.string().trim().max(255),
  text: z.string().max(MAX_NODE_CHARS),
  startRef: z.string().trim().max(255).nullish(),
  endRef: z.string().trim().max(255).nullish(),
  /** The book's extracted cast, already shortlisted by the caller. */
  participants: z.array(z.string().trim().min(1).max(255))
    .max(MAX_PARTICIPANT_CANDIDATES)
    .optional(),
  /** Candidate related passages, already shortlisted by the caller. */
  related: z.array(candidateSchema).max(MAX_RELATED_CANDIDATES).optional(),
})

const bodySchema = z.object({
  projectId: z.string().trim().min(1).max(255),
  /** One window, in document order, all from the SAME file: `scene_change` is a
   *  question about a node and its predecessor, so order is load-bearing. */
  nodes: z.array(nodeSchema).min(1).max(MAX_NODES_PER_REQUEST),
})

export interface PassageTagResult extends PassageTags {
  /** Echoes `nodeKey`; present so a caller can key its cache from the result
   *  without relying on array position surviving a round trip. */
  nodeKey: string
}

function toRequests(input: z.infer<typeof bodySchema>): TaggedNodeRequest[] {
  return input.nodes.map((node) => {
    const value: PassageTagNode = {
      key: node.key,
      label: node.label,
      text: node.text,
      startRef: node.startRef ?? null,
      endRef: node.endRef ?? null,
    }
    const candidates: TagCandidates = {
      participants: node.participants ?? [],
      related: node.related ?? [],
    }
    return { node: value, candidates }
  })
}

/** Heuristic-only answer for the whole window — the shape every failure path
 *  returns, so a caller cannot tell an outage from a low-confidence file apart
 *  from `decidedBy`, and does not need to. */
function heuristicWindow(nodes: readonly TaggedNodeRequest[]): PassageTagResult[] {
  return nodes.map((entry, index) =>
    combinePassageTags(entry.node, nodes[index - 1]?.node ?? null, entry.candidates, null))
}

/**
 * Resolve the decisions endpoint. Same derivation as the seam route's — see
 * ./ai-seams.ts: OpenRouter fronts TypeSafe's evaluation API at
 * `/api/alpha/decisions`, a SIBLING of `/api/v1`, so deriving it from
 * OPENROUTER_BASE_URL replaces the version segment rather than appending.
 */
export function resolvePassageTagUrl(env: Pick<Env, "OPENROUTER_BASE_URL">): string {
  const base = env.OPENROUTER_BASE_URL?.trim()
  if (!base) return JEV_DECISIONS_URL
  const trimmed = base.replace(/\/+$/, "")
  const withoutVersion = trimmed.replace(/\/v\d+$/, "")
  return `${withoutVersion}/alpha/decisions`
}

aiPassageTags.post(
  "/classify",
  authMiddleware,
  zValidator("json", bodySchema),
  async (c) => {
    const input = c.req.valid("json")
    const user = c.get("user")

    const role = await resolveProjectRole(c.env, user, input.projectId)
    if (!role || role.level < MIN_TAG_ROLE) {
      return c.json(
        { error: "permission_denied", message: "Project access is required." },
        403,
      )
    }

    const nodes = toRequests(input)

    const identifier = `user:${user.id}`
    const recent = await countRecentRateLimitEvents(c.env.AQUILLA_PG, "ai_passage_tags", identifier)
    if (recent >= TAGS_MAX_PER_USER_PER_WINDOW) {
      // Rate-limited is still a 200 of heuristic tags rather than a 429, for the
      // same reason the seam route answers that way: the caller is a background
      // job whose only sensible response to an error is to use the heuristic
      // anyway, and failing it loudly would turn a cost control into an outage
      // of a feature that has a working fallback.
      return c.json({ tags: heuristicWindow(nodes), model: null, rateLimited: true })
    }
    await recordRateLimitEvent(c.env.AQUILLA_PG, "ai_passage_tags", identifier)

    if (!c.env.OPENROUTER_API_KEY) {
      return c.json({ tags: heuristicWindow(nodes), model: null })
    }

    let answers: ReturnType<typeof parsePassageTagAnswers> | null = null
    try {
      const res = await fetch(resolvePassageTagUrl(c.env), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildPassageTagRequest(nodes)),
        signal: AbortSignal.timeout(TAG_TIMEOUT_MS),
      })
      if (res.ok) {
        answers = parsePassageTagAnswers(await res.json(), nodes)
      } else {
        console.warn(`[ai-passage-tags] upstream ${res.status}; using heuristic tags`)
      }
    } catch (err) {
      console.warn("[ai-passage-tags] tagging failed; using heuristic tags:", err)
    }

    if (!answers) return c.json({ tags: heuristicWindow(nodes), model: null })

    // The combine rule runs HERE, not in the client, and the client re-runs the
    // identical function over cached answers. One implementation, in
    // src/lib/understanding/passage-tags.ts, imported by both.
    const tags: PassageTagResult[] = nodes.map((entry, index) =>
      combinePassageTags(
        entry.node,
        nodes[index - 1]?.node ?? null,
        entry.candidates,
        answers?.[index],
        DEFAULT_TAG_THRESHOLDS,
      ))

    return c.json({ tags, model: JEV_MODEL })
  },
)

export default aiPassageTags
