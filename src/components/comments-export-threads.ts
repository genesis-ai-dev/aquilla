// AQU-1958: turn the thread list a comments page has on screen into the rows
// the CSV export writes.
//
// Pure, and deliberately label-driven: it takes the names the page already
// resolved (project, file, cell place) rather than ids, so the export can never
// disagree with what the person exporting it is looking at — and never leaks a
// raw uuid into a column (AQU-295).

import type { CommentCsvThread } from "@/lib/comments/comments-csv"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { resolveFileName } from "./comments-page-filters"
import { cellPlaceKey, formatScriptureRef } from "./comments-cell-preview"

export interface BuildCommentCsvThreadsInput {
  /** The visible thread roots, already filtered and sorted by the page. */
  roots: readonly CommentRecord[]
  repliesByParent: Map<string, CommentRecord[]>
  /** projectId → display name. One entry on a project page; many on the org view. */
  projectNames: Map<string, string>
  /** fileId → display name, for every project in `roots`. */
  fileMap: Map<string, string>
  /** `cellPlaceKey(fileId, cellId)` → resolved place ("Genesis 1:1"). */
  places?: Map<string, string>
  t?: TFunction
}

export function buildCommentCsvThreads({
  roots,
  repliesByParent,
  projectNames,
  fileMap,
  places,
  t,
}: BuildCommentCsvThreadsInput): CommentCsvThread[] {
  return roots.map((root) => ({
    root,
    replies: repliesByParent.get(root.commentId) ?? [],
    projectName: projectNames.get(root.projectId) ?? "",
    // A project-scoped thread belongs to no file; a cell/file thread shows the
    // file's name, or the deleted-file tombstone the page shows for it.
    fileName: root.scopeKind === "project" || !root.fileId
      ? ""
      : resolveFileName(root.fileId, fileMap, t).name,
    reference: root.scopeKind === "cell"
      ? (root.fileId && root.cellId ? places?.get(cellPlaceKey(root.fileId, root.cellId)) : undefined)
        ?? formatScriptureRef(root.cellRef)
        ?? ""
      : "",
  }))
}
