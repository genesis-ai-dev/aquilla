import { defineNamespace, plural } from "./types"

export const agentDraftReview = defineNamespace({
  keys: {
    "agentDraftReview.title": "Review task drafts",
    "agentDraftReview.pending": plural({
      one: "{count} pending draft",
      other: "{count} pending drafts",
    }),
    "agentDraftReview.position": "Draft {position} of {total}",
    "agentDraftReview.previous": "Previous draft",
    "agentDraftReview.next": "Next draft",
    "agentDraftReview.scope": "Pending suggestions from this task only.",
    "agentDraftReview.defaultLane": "Project-default language",
    "agentDraftReview.stored": "Saved translation",
    "agentDraftReview.noTranslation": "No saved translation yet.",
    "agentDraftReview.source": "Source context",
    "agentDraftReview.sourceMissing": "The source for this suggestion is unavailable. Refresh before accepting.",
    "agentDraftReview.suggestion": "Proposed translation",
    "agentDraftReview.edit": "Edit before accepting",
    "agentDraftReview.editLabel": "Your version of the suggestion",
    "agentDraftReview.editHelp": "Changes stay here until you accept. The task’s original proposal is not modified.",
    "agentDraftReview.acceptEdited": "Accept edited translation",
    "agentDraftReview.empty": "No pending drafts for this task",
    "agentDraftReview.emptyHelp": "Its suggestions have been reviewed or superseded. Return to the conversation to continue.",
    "agentDraftReview.readOnly": "You can inspect suggestions. Accepting, editing, and dismissing require Contributor access.",
    "agentDraftReview.loadFailed": "Could not load this task’s drafts. {message}",
    "agentDraftReview.writeFailed": "Could not finish accepting this suggestion. {message}",
    "agentDraftReview.stale": "The source, translation, or proposal changed. Refresh and review it again before accepting.",
    "agentDraftReview.locked": "Another contributor is editing this segment.",
    "agentDraftReview.queued": "This edit is queued but not yet confirmed. Retry sync; do not accept it again.",
    "agentDraftReview.retrySync": "Retry sync",
    "agentDraftReview.unavailable": "Draft review is not available for this task.",
    "agentDraftReview.rejected": "The server rejected this edit. Refresh before trying again.",
  },
  context: {
    _context: {
      description: "Focused Agent task review, inside the conversation route. Source, saved target text, and an uncommitted proposal are separate. Review never changes the user's preferred Audio/Text editor mode.",
    },
    keys: {
      "agentDraftReview.pending": {
        description: "Authoritative number of pending proposals owned by the selected task, not the whole file.",
        placeholders: { count: "Number of this task's pending proposals." },
      },
      "agentDraftReview.position": {
        description: "Position of the focused proposal among this task's pending proposals.",
        placeholders: { position: "One-based position.", total: "Number of pending proposals." },
      },
      "agentDraftReview.loadFailed": {
        description: "Explicit load error; never represent a failed request as an empty review queue.",
        placeholders: { message: "Failure detail from the request." },
      },
      "agentDraftReview.writeFailed": {
        description: "Commit failure. A queued edit is not a confirmed saved translation.",
        placeholders: { message: "Failure detail from the existing commit/outbox path." },
      },
    },
  },
  surfaces: [],
})
