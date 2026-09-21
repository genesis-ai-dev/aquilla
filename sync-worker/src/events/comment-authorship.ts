// Agent-authored comment labelling (AQU-1233).
//
// A comment written through the Agent API is authored AS the credential's
// minting user — `comments.author_id` is that human, so foreign-comment role
// floors, "my comments" filters and edit/delete authority all keep working
// unchanged. What differs is that a person did not type it, and a reviewer
// reading the thread has to be able to see that.
//
// The marker therefore rides `comments.author_label`, which is exactly what the
// comment surfaces render (`authorLabel ?? authorId` in CommentsDrawer /
// CommentsPage). No column, no migration, no second authorship concept — the
// display name says "answered by their tool", the identity underneath does not
// move.
//
// Both the projection (which writes the label) and the external read surface
// (which reports `viaAgent` back to agents) key off this one constant so the
// two can never drift.

/** Suffix appended to an agent-posted comment's display label. */
export const AGENT_COMMENT_LABEL_SUFFIX = ' (via agent)'

/** The label to persist for a comment authored by `author`. */
export function commentAuthorLabel(author: string, viaAgent: boolean | undefined): string {
  return viaAgent === true ? `${author}${AGENT_COMMENT_LABEL_SUFFIX}` : author
}

/** Whether a stored label marks its comment as agent-posted. */
export function isAgentAuthoredLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && label.endsWith(AGENT_COMMENT_LABEL_SUFFIX)
}
