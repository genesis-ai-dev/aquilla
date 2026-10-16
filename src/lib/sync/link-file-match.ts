// AQU-1679 — how one of this project's files compares with the upstream file a
// link could have it follow.
//
// Linking adds each upstream file as a new file (AQU-1525). For a file this
// project already holds — the same material, imported on its own — the confirm
// step can instead have the link replace the source IN that file, so the team's
// translations end up on the linked source rather than beside it. Before the
// lead commits to that, the step shows what it will do, line by line in
// aggregate: how many lines are the same, how many take the upstream's text,
// how many are added, how many only this project has.
//
// The server answers (auth-worker `POST /api/v2/projects/:id/link-source/match`)
// because it is the same pairing the mirror then performs — an estimate made
// here could promise a match the sync does not make.
//
// Kept out of `archive.ts` and `link-source-preview.ts` on purpose: component
// tests stub both of those wholesale, and a new export on a stubbed module is a
// missing export in every one of them.

import { UserError } from "../errors/user-error"
import { FRONTIER_API_URL } from "./sync-token"

/** One "replace the source in my existing file" pair. */
export interface ReplaceFilePair {
  /** The upstream file the link would follow. */
  upstreamFileId: string
  /** This project's own file whose source it would replace. */
  fileId: string
}

export interface LinkFileMatch extends ReplaceFilePair {
  /** One of the two files no longer exists (or is in Recently deleted). */
  missing: boolean
  upstreamLines: number
  localLines: number
  /** Lines with identical text in both files. */
  same: number
  /** Lines that pair up but differ: the upstream's text replaces this file's. */
  changed: number
  /** Lines only the upstream has: they are added to this file. */
  added: number
  /** Lines only this file has: they stay as they are. */
  kept: number
  /** False when the two files are not the same material; the server refuses a
   *  link that asks to replace such a file. */
  canReplace: boolean
}

export async function fetchLinkFileMatches(
  jwt: string,
  projectId: string,
  sourceProjectId: string,
  files: readonly ReplaceFilePair[],
  apiUrl: string = FRONTIER_API_URL,
): Promise<LinkFileMatch[]> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source/match`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ sourceProjectId, files }),
    },
  )
  if (!res.ok) {
    throw new UserError(res.status, await res.text().catch(() => ""), "project")
  }
  const body = (await res.json()) as { files?: LinkFileMatch[] }
  return body.files ?? []
}
