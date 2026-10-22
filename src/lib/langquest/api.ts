/**
 * Client for the LangQuest link API (auth-worker /api/v2/langquest/*) — the
 * same fetch/auth style as src/lib/airtable/api.ts. The browser sends the
 * pasted token once (inspect, link) and never sees it again: every LangQuest
 * read after that goes through the project's link on the server.
 */

import { AUTH_BASE } from "../frontier/auth"
import type {
  KnownPassage,
  LangQuestChange,
  LangQuestInspection,
  LangQuestLink,
  LangQuestPassage,
} from "./types"

const BASE = `${AUTH_BASE}/api/v2/langquest`

function headers(jwt: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }
}

/** A non-2xx from the link API. The UI words it from `status`/`reason`; `message` is diagnostic. */
export class LangQuestLinkError extends Error {
  readonly status: number
  readonly reason: string | null
  /** LangQuest no longer accepts the token: paste a new one. */
  readonly needsReauth: boolean
  constructor(message: string, status: number, reason: string | null, needsReauth: boolean) {
    super(message)
    this.name = "LangQuestLinkError"
    this.status = status
    this.reason = reason
    this.needsReauth = needsReauth
  }

  /** LangQuest's change-feed cursor is too old; start again from a full listing. */
  get cursorExpired(): boolean {
    return this.status === 410
  }
}

async function call<T>(jwt: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers(jwt) })
  if (!res.ok) {
    let body: { error?: string; reason?: string; needsReauth?: boolean } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      // non-JSON body
    }
    throw new LangQuestLinkError(body.error ?? `HTTP ${res.status}`, res.status, body.reason ?? null, !!body.needsReauth)
  }
  return (await res.json()) as T
}

const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`

export const inspectLangQuestToken = (jwt: string, token: string) =>
  call<LangQuestInspection>(jwt, "/inspect", { method: "POST", body: JSON.stringify({ token }) })

export const fetchLangQuestLink = async (jwt: string, projectId: string) =>
  (await call<{ link: LangQuestLink | null }>(jwt, `${project(projectId)}/link`)).link

export const linkLangQuest = async (jwt: string, projectId: string, token: string, languageId: string) =>
  (
    await call<{ link: LangQuestLink }>(jwt, `${project(projectId)}/link`, {
      method: "PUT",
      body: JSON.stringify({ token, languageId }),
    })
  ).link

export const unlinkLangQuest = (jwt: string, projectId: string, opts: { revoke: boolean }) =>
  call<{ ok: true; revoked: boolean }>(jwt, `${project(projectId)}/link${opts.revoke ? "?revoke=1" : ""}`, {
    method: "DELETE",
  })

export const fetchLangQuestState = (jwt: string, projectId: string) =>
  call<{ link: LangQuestLink; cursor: string | null; passages: KnownPassage[] }>(jwt, `${project(projectId)}/state`)

export const saveLangQuestState = (
  jwt: string,
  projectId: string,
  body: {
    upserts?: KnownPassage[]
    removed?: string[]
    cursor?: string | null
    outcome?: { error: string | null }
  },
) => call<{ ok: true }>(jwt, `${project(projectId)}/state`, { method: "POST", body: JSON.stringify(body) })

export const fetchLangQuestChanges = (jwt: string, projectId: string, after: string | null) =>
  call<{ changes: LangQuestChange[]; cursor: string; more: boolean }>(
    jwt,
    `${project(projectId)}/changes${after ? `?after=${encodeURIComponent(after)}` : ""}`,
  )

export function fetchLangQuestPassages(
  jwt: string,
  projectId: string,
  opts: { after?: string | null; unitIds?: string[] },
) {
  const q = new URLSearchParams()
  if (opts.after) q.set("after", opts.after)
  for (const id of opts.unitIds ?? []) q.append("unitIds", id)
  const qs = q.toString()
  return call<{ passages: LangQuestPassage[]; nextAfter: string | null }>(
    jwt,
    `${project(projectId)}/passages${qs ? `?${qs}` : ""}`,
  )
}

/** One audio card's bytes, through the link's server-side proxy. */
export async function fetchLangQuestAudio(jwt: string, projectId: string, url: string): Promise<Blob> {
  const res = await fetch(`${BASE}${project(projectId)}/audio?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new LangQuestLinkError(`audio HTTP ${res.status}`, res.status, "audio_unavailable", false)
  return res.blob()
}

export const publishLangQuestReleases = (
  jwt: string,
  projectId: string,
  body: { channel: string; live: boolean; url?: string },
) =>
  call<{ released: number; unchanged: number; failed: { unitId: string; error: string }[] }>(
    jwt,
    `${project(projectId)}/releases`,
    { method: "POST", body: JSON.stringify(body) },
  )
