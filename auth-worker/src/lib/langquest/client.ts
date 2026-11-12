// A thin client for LangQuest's partner API (next.langquest.org/api/v1).
//
// LangQuest documents it in its own repo (docs/agent-api.md) and serves the
// OpenAPI document at GET /api/v1/openapi.json. The shapes below mirror its
// apps/web/worker/agent/view.ts; only the fields Aquilla reads are typed.
//
// LangQuest has no projects, quests or text: an organization holds languages,
// a language holds passages (units), and a passage's versions are audio made
// of ordered "cards". Every route needs `Authorization: Bearer lqp_…`.

import type { Env } from "../../types"

export const DEFAULT_LANGQUEST_API_BASE = "https://next.langquest.org/api/v1"

export function langquestApiBase(env: Pick<Env, "LANGQUEST_API_BASE">): string {
  return (env.LANGQUEST_API_BASE?.trim() || DEFAULT_LANGQUEST_API_BASE).replace(/\/+$/, "")
}

export type LangQuestScope = "read:published" | "read" | "review" | "release" | "external_values"

export interface LangQuestCan {
  read: "all" | "published" | null
  review: boolean
  release: boolean
  externalValues: { read: boolean; write: boolean }
}

export interface LangQuestLanguage {
  languageId: string
  name: string
  code: string
  country: string | null
  can: LangQuestCan
}

export interface LangQuestMe {
  token: {
    id: string
    orgId: string
    name: string
    scopes: LangQuestScope[]
    languageIds: string[] | null
    expiresAt: string | null
  }
  org: { id: string; name: string }
  languages: LangQuestLanguage[]
}

export interface LangQuestAudioCard {
  hash: string
  format: "wav" | "m4a"
  durationMs: number
  url: string
  expiresAt: string
}

export interface LangQuestPassage {
  unitId: string
  label: string
  path: string[]
  kind: string
  order: string
  reference: {
    book: string
    chapter: number | null
    verse: number | null
    endChapter: number | null
    endVerse: number | null
  } | null
  status: "not_started" | "drafting" | "in_review" | "feedback" | "approved"
  version: { n: number; takeId: string; submittedAt: string; durationMs: number } | null
  approvedVersion: { n: number; takeId: string } | null
  releases: { channel: string; versionN: number; takeId: string; url?: string; at: string }[]
  updatedAt: string | null
  /** Present when the list was asked for `include=audio`. */
  audio?: LangQuestAudioCard[]
}

export interface LangQuestChange {
  cursor: string
  type: string
  unitId: string
  at: string
}

/** A non-2xx from LangQuest. `code` is LangQuest's own (`unauthorized`, `scope`, `cursor_expired`, …). */
export class LangQuestApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = "LangQuestApiError"
  }

  /** The token was revoked, expired or never valid: the link needs a new one. */
  get tokenRejected(): boolean {
    return this.status === 401
  }
}

export class LangQuestClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${this.token}`,
      },
    })
    if (!res.ok) {
      let body: { error?: string; code?: string } = {}
      try {
        body = (await res.json()) as typeof body
      } catch {
        // non-JSON error body
      }
      throw new LangQuestApiError(res.status, body.code ?? null, body.error ?? `LangQuest answered ${res.status}`)
    }
    return (await res.json()) as T
  }

  me(): Promise<LangQuestMe> {
    return this.request<LangQuestMe>("/me")
  }

  /** One page of passages, always with their current version's audio. */
  passages(
    languageId: string,
    opts: { unitIds?: string[]; after?: string | null; limit?: number } = {},
  ): Promise<{ passages: LangQuestPassage[]; nextAfter: string | null }> {
    const q = new URLSearchParams({ include: "audio", limit: String(opts.limit ?? 100) })
    if (opts.after) q.set("after", opts.after)
    // Repeated, never comma-joined: a unit id may hold a comma (agent-api.md).
    for (const id of opts.unitIds ?? []) q.append("unitIds", id)
    return this.request(`/languages/${encodeURIComponent(languageId)}/passages?${q}`)
  }

  changes(
    languageId: string,
    after: string | null,
  ): Promise<{ changes: LangQuestChange[]; cursor: string; more: boolean }> {
    const q = new URLSearchParams({ limit: "1000" })
    if (after) q.set("after", after)
    return this.request(`/languages/${encodeURIComponent(languageId)}/changes?${q}`)
  }

  release(
    languageId: string,
    unitId: string,
    body: { channel: string; live: boolean; url?: string },
  ): Promise<unknown> {
    return this.request(
      `/languages/${encodeURIComponent(languageId)}/passages/${encodeURIComponent(unitId)}/releases`,
      { method: "POST", body: JSON.stringify(body) },
    )
  }

  /** The app's "Disconnect": LangQuest revokes this token. */
  revoke(): Promise<unknown> {
    return this.request("/token", { method: "DELETE" })
  }
}

/**
 * Whether `url` is one of LangQuest's signed audio links, served from the
 * same origin as the API under /api/blobs/. The audio proxy fetches nothing
 * else, so a caller cannot turn it into a request to an arbitrary host.
 */
export function isLangQuestBlobUrl(apiBase: string, url: string): boolean {
  let target: URL
  let api: URL
  try {
    target = new URL(url)
    api = new URL(apiBase)
  } catch {
    return false
  }
  return target.origin === api.origin && target.pathname.startsWith("/api/blobs/")
}
