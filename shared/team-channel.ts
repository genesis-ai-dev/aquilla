/**
 * team-channel.ts — wire shapes for the durable team channel (v2 one-channel
 * model, docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md).
 *
 * Types only, no zod: auth-worker pins zod 3 and the SPA pins zod 4, so a
 * schema declared here would have to pick one and break the other. Request
 * validation lives next to the router (auth-worker/src/routes/team.ts).
 *
 * The persona ids mirror `src/lib/agent/personas.ts` exactly — that module
 * decides which teammate speaks for a piece of client-side activity, and the
 * server-side ingestion write-through has to make the same call so a message
 * derived on the server is attributed identically to one derived in the
 * browser. An anonymous actor breaks the social framing.
 */

export const TEAM_PERSONA_IDS = ["drafter", "reviewer", "coordinator"] as const
export type TeamPersonaId = (typeof TEAM_PERSONA_IDS)[number]

export type TeamThreadSourceKind = "run" | "human"
export type TeamThreadStatus = "open" | "closed"

export interface TeamThread {
  id: string
  projectId: string
  sourceKind: TeamThreadSourceKind
  /** The work item this thread covers — a contextual run id for `run`. */
  sourceRef: string | null
  title: string
  status: TeamThreadStatus
  createdAt: string
  updatedAt: string
}

export type TeamMessageAuthor =
  | { kind: "human"; id: string }
  | { kind: "persona"; id: TeamPersonaId | string }

export type TeamMessageBodyKind = "text" | "activity" | "question"

/** Plain talk — a human posting, or the Coordinator dispatching work. A
 *  dispatch carries `threadId`, which is what makes a main-channel message
 *  the owner of a thread. */
export interface TeamTextBody {
  text: string
  threadId?: string
}

/** One durable pipeline fact, mirroring `TeamFeedBody` in
 *  src/lib/agent/social-feed.ts so both derivations render the same. */
export type TeamActivityBody =
  | { kind: "started"; spanId: string | null; spanLabel: string | null }
  | {
      kind: "phase"
      spanId: string | null
      spanLabel: string | null
      region: "reading" | "drafting" | "checking"
    }
  | {
      kind: "sceneReady"
      spanId: string | null
      spanLabel: string | null
      ambiguityCount: number | null
    }
  | {
      kind: "draftsStaged"
      spanId: string | null
      spanLabel: string | null
      count: number | null
    }
  | {
      kind: "outcome"
      spanId: string | null
      spanLabel: string | null
      status: "done" | "partial" | "failed"
      reasons: string[]
    }

export interface TeamMessage {
  id: string
  projectId: string
  /** NULL/absent means the main channel. */
  threadId: string | null
  author: TeamMessageAuthor
  bodyKind: TeamMessageBodyKind
  body: TeamTextBody | TeamActivityBody | Record<string, unknown>
  createdAt: string
}

/** Newest-last page. `nextBefore` is the cursor for the page of OLDER
 *  messages; null when the caller has reached the start of history. */
export interface TeamMessagePage {
  messages: TeamMessage[]
  nextBefore: string | null
  hasMore: boolean
}

export interface TeamThreadMessagePage extends TeamMessagePage {
  thread: TeamThread
}

/** Ceiling on one page of channel history. */
export const TEAM_MESSAGE_PAGE_MAX = 100
export const TEAM_MESSAGE_PAGE_DEFAULT = 50
/** Ceiling on a human-posted message, in characters. */
export const TEAM_MESSAGE_TEXT_MAX = 12000
/** Ceiling on a thread title, in characters. */
export const TEAM_THREAD_TITLE_MAX = 160
