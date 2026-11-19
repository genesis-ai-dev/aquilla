// AQU-2549 — "Join into my existing file".
//
// A project can hold a mirrored copy of a source file it had already imported
// on its own (a whole-project link brings a matching new file in as a copy, a
// replace was left off, or the duplicate is older than the replace). Joining
// gives the project's own file the source project's text, keeping its
// translations and validations, and sends the copy to Recently deleted.
//
// The server lists the copies (auth-worker `GET /link-source/copies`) because
// a copy is known by the mirror's file identity, never by name; it records the
// join (`POST /link-source/join`) and the mirror sync performs it.
//
// Kept out of `archive.ts` and `link-source-preview.ts` for the reason
// link-file-match.ts gives: component tests stub those wholesale.

import { UserError } from "../errors/user-error"
import { FRONTIER_API_URL } from "./sync-token"
import type { LinkFileMatch } from "./link-file-match"

export interface LinkedFileCopy {
  /** The copy's id in this project. */
  fileId: string
  name: string
  /** The source project's file it mirrors. */
  upstreamFileId: string
  /** Someone translated on the copy itself: it cannot be joined. */
  translated: boolean
  /** This project's own file with the same name, when exactly one has it. */
  suggestedFileId?: string
}

export interface LinkedFileCopies {
  copies: LinkedFileCopy[]
  /** This project's own files a copy can be joined into. */
  ownFiles: Array<{ id: string; name: string }>
}

function headers(jwt: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }
}

export async function fetchLinkedFileCopies(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<LinkedFileCopies> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source/copies`,
    { headers: headers(jwt) },
  )
  if (!res.ok) throw new UserError(res.status, await res.text().catch(() => ""), "project")
  const body = (await res.json()) as Partial<LinkedFileCopies>
  return { copies: body.copies ?? [], ownFiles: body.ownFiles ?? [] }
}

export interface JoinLinkedCopyResult {
  match: LinkFileMatch
  /** False while the sync is still joining a big file. */
  complete: boolean
}

export async function joinLinkedCopy(
  jwt: string,
  projectId: string,
  copyFileId: string,
  fileId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<JoinLinkedCopyResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source/join`,
    { method: "POST", headers: headers(jwt), body: JSON.stringify({ copyFileId, fileId }) },
  )
  if (!res.ok) throw new UserError(res.status, await res.text().catch(() => ""), "project")
  return (await res.json()) as JoinLinkedCopyResult
}
