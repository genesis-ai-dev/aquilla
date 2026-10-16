// AQU-1958: pure helpers for the org-wide comments view.
//
// The view is a fan-out, not a new endpoint: the org's project list names the
// projects the caller may see, and each project's existing comments read is
// called with a token scoped to that project. Access therefore stays exactly
// where the server already enforces it — a project the viewer lacks is not in
// the list, and a token for it cannot be minted — and this module only turns
// the list into the labels and options the page renders.

import { stripAgentCommentMarker } from "./comment-helpers"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

/** A project in the org-wide list, with the file names its comments point at. */
export interface OrgCommentsProject {
  id: string
  name: string
  files: { id: string; name: string }[]
}

/** projectId → display name, for the project badge and the CSV's Project column. */
export function orgProjectNames(
  projects: readonly OrgCommentsProject[],
): Map<string, string> {
  return new Map(projects.map((project) => [project.id, project.name]))
}

/**
 * fileId → display name across every listed project. File ids are uuids, so a
 * single flat map is safe; a name collision between projects is a display
 * collision only, and the project badge disambiguates it on screen.
 */
export function orgFileNames(
  projects: readonly OrgCommentsProject[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const project of projects) {
    for (const file of project.files) map.set(file.id, file.name)
  }
  return map
}

/**
 * Project filter options, narrowed to the projects that actually have a comment
 * in the loaded set — an org with 40 projects and comments in 4 should not open
 * a 40-entry picker. Sorted by name for a stable, scannable list.
 */
export function orgProjectFilterOptions(
  projects: readonly OrgCommentsProject[],
  comments: readonly CommentRecord[],
): { id: string; name: string }[] {
  const withComments = new Set(comments.map((comment) => comment.projectId))
  return projects
    .filter((project) => withComments.has(project.id))
    .map((project) => ({ id: project.id, name: project.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Author filter options across every project in the loaded set. One entry per
 * person, named without the "(via agent)" marker a single agent-posted comment
 * would otherwise stamp on the filter (AQU-1233).
 */
export function orgAuthorFilterOptions(
  comments: readonly CommentRecord[],
): { id: string; label: string }[] {
  const authors = new Map<string, string>()
  for (const comment of comments) {
    authors.set(comment.authorId, stripAgentCommentMarker(comment.authorLabel ?? comment.authorId))
  }
  return Array.from(authors.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * File filter options for the loaded set, restricted to the selected project
 * when one is picked. Unknown ids (a file deleted since the comment was
 * written) are dropped rather than listed as a tombstone: a filter entry nobody
 * can interpret is worse than one fewer option, and the threads themselves
 * still show the tombstone.
 */
export function orgFileFilterOptions(
  comments: readonly CommentRecord[],
  fileNames: Map<string, string>,
  projectId = "",
): { id: string; name: string }[] {
  const ids = new Set<string>()
  for (const comment of comments) {
    if (!comment.fileId) continue
    if (projectId && comment.projectId !== projectId) continue
    ids.add(comment.fileId)
  }
  return Array.from(ids)
    .flatMap((id) => {
      const name = fileNames.get(id)
      return name === undefined ? [] : [{ id, name }]
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
