import { defineNamespace } from "./types"

export const comments = defineNamespace({
  keys: {
    // Sort picker
    "comments.sort.unresolvedFirst": "Unresolved first",
    "comments.sort.recentActivity": "Most recent activity",
    "comments.sort.newest": "Newest first",

    // File resolution
    "comments.file.unknown": "Unknown file",
    "comments.file.deleted": "Deleted file",
    "comments.file.deletedBadge": "deleted",

    // Thread scope label (which cell/file/the whole project a thread is on)
    "comments.scope.cell": "{cell} in {file}",
    "comments.scope.file": "File {file}",

    // @mention composer (shared by the reply and edit textareas)
    "comments.mention.typeMore": "Type more to search…",
    "comments.mention.noResults": "No users found.",
    "comments.composer.editPlaceholder": "Edit comment…",
    "comments.composer.replyPlaceholder": "Reply… (type @ to mention)",

    // Single comment bubble
    "comments.bubble.actionsLabel": "Comment actions",
    "comments.bubble.edited": "(edited)",
    "comments.bubble.deletedBody": "[deleted]",

    // Delete-comment confirmation
    "comments.deleteDialog.title": "Delete comment?",
    "comments.deleteDialog.description":
      "This comment will be permanently removed. This action cannot be undone.",

    // Thread card header
    "comments.goToCell": "Go to cell in editor",
    "comments.openFile": "Open file",
    "comments.fileDeletedTooltip": "File has been deleted",
    "comments.resolve": "Resolve",
    "comments.reopen": "Reopen",
    "comments.status.open": "open",
    "comments.status.resolved": "resolved",
    "comments.stale.badge": "stale",
    "comments.stale.tooltip": "Translation changed since this thread was created",
    "comments.reply.notWired":
      "Replies from this view are not yet wired — open the cell in the editor to reply.",

    // In-thread reply composer (CommentThread.tsx — no @mention hint here)
    "comments.thread.replyPlaceholder": "Reply...",
    "comments.thread.reply": "Reply",
    "comments.thread.closeWithReply": "Close with reply",

    // Filter bar
    "comments.filter.searchPlaceholder": "Search comments…",
    "comments.filter.filtersButton": "Filters",
    "comments.filter.sortLabel": "Sort",
    "comments.filter.showResolved": "Show resolved",
    "comments.filter.allFiles": "All files",
    "comments.filter.authorLabel": "Author",
    "comments.filter.participantLabel": "Participant",
    "comments.filter.anyone": "Anyone",

    // Page chrome
    "comments.backToProject": "Back to project",
    "comments.page.titleWithProject": "{projectName} — Comments",
    "comments.filterCount.one": "{count} filter",
    "comments.filterCount.other": "{count} filters",
    "comments.loadError": "Failed to load comments. Check your connection and try refreshing.",
    "comments.empty.title": "No comments yet",
    "comments.empty.body": "Comments can be added from the cell menu in the editor.",
    "comments.noMatch.title": "No threads match your filters",
    "comments.noMatch.clear": "Clear filters",

    // CommentsDrawer (per-cell comments panel in the editor)
    "comments.drawer.closeLabel": "Close comments",
    "comments.drawer.noComments": "No comments yet.",
    "comments.drawer.newThreadHeading": "New thread",
    "comments.drawer.newThreadPlaceholder": "Start a new comment thread...",
    "comments.drawer.post": "Post",
  },
  context: {
    _context: {
      description:
        "Comment threads on project cells, files, or the project as a whole — both the " +
        "full-page thread list (/project/:id/comments) and the per-cell drawer opened " +
        "from the editor. Comment bodies and author names are user-authored content and " +
        "are never translated; only the surrounding chrome (labels, buttons, empty " +
        "states, relative-time wording) is keyed here.",
      screenshot: "comments",
    },
    keys: {
      "comments.sort.unresolvedFirst": {
        description: "Option in the thread-list sort picker: unresolved threads first.",
      },
      "comments.sort.recentActivity": {
        description:
          "Option in the thread-list sort picker: order by the most recently active " +
          "thread (last reply or edit), newest activity first.",
      },
      "comments.sort.newest": {
        description:
          "Option in the thread-list sort picker: order by thread creation time, " +
          "newest first.",
      },
      "comments.file.unknown": {
        description:
          "Placeholder file name shown for a thread whose fileId could not be resolved " +
          "at all (no matching file was ever loaded). Distinct from " +
          "comments.file.deleted, which is a file that existed and was removed.",
      },
      "comments.file.deleted": {
        description:
          "Placeholder file name shown in place of the real name when the file a " +
          "thread was attached to has since been deleted from the project.",
      },
      "comments.file.deletedBadge": {
        description:
          "Small inline badge next to a thread's scope label, flagging that the file " +
          "it references has been deleted. Lowercase, single word; sits beside a " +
          "'resolved' badge of the same size, so keep it short.",
      },
      "comments.scope.cell": {
        description:
          "Thread scope label shown above a thread card: which cell, in which file, " +
          "the thread is attached to. {cell} is already a formatted label (a Bible " +
          "reference like 'GEN 1:1', or the localized common.cellLabel " +
          "string) and {file} is the file's display name — reorder them to whatever " +
          "reads naturally, this is not necessarily 'X in Y' in every language.",
        placeholders: {
          cell: "Formatted cell reference or fallback label, not user text.",
          file: "Display name of the file the cell belongs to.",
        },
      },
      "comments.scope.file": {
        description:
          "Thread scope label for a thread attached to a whole file rather than a " +
          "single cell.",
        placeholders: { file: "Display name of the file." },
      },
      "comments.mention.typeMore": {
        description:
          "Hint shown in the @mention dropdown while the typed query is still too " +
          "short to search on.",
      },
      "comments.mention.noResults": {
        description: "Empty-state row in the @mention dropdown when no user matches the query.",
      },
      "comments.composer.editPlaceholder": {
        description:
          "Placeholder text of the textarea shown when editing an existing comment's " +
          "body in place.",
      },
      "comments.composer.replyPlaceholder": {
        description:
          "Placeholder text of the reply textarea on the full-page thread list, which " +
          "supports @mention — distinct from comments.thread.replyPlaceholder, the " +
          "plainer reply box inside the editor's per-cell drawer.",
      },
      "comments.bubble.actionsLabel": {
        description:
          "Accessible label for the '⋯' icon button on a comment the current user " +
          "authored, which opens the Edit/Delete menu.",
      },
      "comments.bubble.edited": {
        description:
          "Small inline marker shown next to a comment's timestamp when it has been " +
          "edited since it was first posted. Parenthesized, lowercase adjective form.",
      },
      "comments.bubble.deletedBody": {
        description:
          "Replaces a comment's body once it has been deleted, in square brackets, so " +
          "the thread's shape (who replied, when) stays visible without the content.",
      },
      "comments.deleteDialog.title": {
        description:
          "Heading of the confirmation dialog shown before permanently deleting a " +
          "single comment. A short question, not a statement.",
      },
      "comments.deleteDialog.description": {
        description:
          "Body text of the delete-comment confirmation dialog, warning that the " +
          "action is permanent and cannot be undone.",
      },
      "comments.goToCell": {
        description:
          "Tooltip on the 'Open file' button of a cell-scoped thread, when the file " +
          "still exists and can be opened in the editor.",
      },
      "comments.openFile": {
        description:
          "Button on a cell-scoped thread that navigates to that cell in the editor. " +
          "Also rendered disabled (paired with comments.fileDeletedTooltip) when the " +
          "file no longer exists.",
      },
      "comments.fileDeletedTooltip": {
        description:
          "Tooltip on the disabled 'Open file' button, explaining why the thread " +
          "cannot be opened in the editor.",
      },
      "comments.resolve": {
        description:
          "Button that marks an open thread resolved. Shown both as the toggle in a " +
          "thread card's header and as a standalone action inside an open thread's " +
          "reply area (comments.thread.* strings). Imperative verb.",
      },
      "comments.reopen": {
        description:
          "Button that reopens a resolved thread. Pairs with comments.resolve as the " +
          "same toggle in two places: a thread card's header, and inside a resolved " +
          "thread. Imperative verb.",
      },
      "comments.status.open": {
        description:
          "Status badge on a thread showing it is still open. Lowercase, single word — " +
          "matches the visual weight of comments.status.resolved beside it.",
      },
      "comments.status.resolved": {
        description:
          "Status badge on a thread showing it has been resolved. Lowercase, single " +
          "word. Same string is reused for the small 'resolved' badge in the thread " +
          "list's card header.",
      },
      "comments.stale.badge": {
        description:
          "Short badge label next to a thread's status badge, flagging that the " +
          "translation has changed since the thread was created. Single word, sits in " +
          "a narrow strip alongside an icon.",
      },
      "comments.stale.tooltip": {
        description:
          "Tooltip explaining the comments.stale.badge label: the translated text has " +
          "changed since this thread was opened, so the discussion may be about " +
          "outdated wording.",
      },
      "comments.reply.notWired": {
        description:
          "Explanatory note under the reply box on the full-page thread list, telling " +
          "the user that replying there isn't wired up yet and to use the editor's " +
          "drawer instead. Full sentence, not a button.",
      },
      "comments.thread.replyPlaceholder": {
        description:
          "Placeholder text of the reply textarea inside the editor's per-cell " +
          "comments drawer (CommentThread). Plainer than " +
          "comments.composer.replyPlaceholder — this box has no @mention support.",
        screenshot: "cell-editor",
      },
      "comments.thread.reply": {
        description:
          "Button that submits the reply textarea's contents as a new reply in the " +
          "thread. Imperative verb, paired with a send icon.",
        screenshot: "cell-editor",
      },
      "comments.thread.closeWithReply": {
        description:
          "Button that submits the reply text AND resolves the thread in one action. " +
          "Sits beside comments.thread.reply; should read as doing both things, not " +
          "just closing.",
        screenshot: "cell-editor",
      },
      "comments.filter.searchPlaceholder": {
        description: "Placeholder text of the free-text search box in the thread-list filter bar.",
      },
      "comments.filter.filtersButton": {
        description:
          "Button that expands/collapses the advanced filter row (sort, show-resolved, " +
          "file, author, participant). Toggles state; label doesn't change.",
      },
      "comments.filter.sortLabel": {
        description: "Form label beside the sort-order picker in the filter row.",
      },
      "comments.filter.showResolved": {
        description: "Checkbox label: include resolved threads in the visible list.",
      },
      "comments.filter.allFiles": {
        description: "Option in the file picker meaning no file filter is applied.",
      },
      "comments.filter.authorLabel": {
        description: "Form label beside the thread-author picker in the filter row.",
      },
      "comments.filter.participantLabel": {
        description:
          "Form label beside the participant picker in the filter row — matches " +
          "threads where the given user is the root author OR any replier, not just " +
          "the thread starter.",
      },
      "comments.filter.anyone": {
        description:
          "Option shared by both the author and participant pickers meaning no " +
          "person filter is applied.",
      },
      "comments.backToProject": {
        description:
          "Button at the top of the full-page thread list that navigates back to the " +
          "project's editor.",
      },
      "comments.page.titleWithProject": {
        description:
          "Heading of the full-page thread list once the project name has loaded — " +
          "the project name prefixes the word 'Comments'. Reorder freely; the dash is " +
          "not required to stay literal.",
        placeholders: { projectName: "The current project's display name." },
      },
      "comments.filterCount.one": {
        description:
          "Small badge next to the header showing how many filters are currently " +
          "active, singular case (exactly one filter active).",
        placeholders: { count: "Always the literal number 1 in this branch." },
      },
      "comments.filterCount.other": {
        description:
          "Same badge as comments.filterCount.one, plural case (two or more filters " +
          "active — this branch is never shown for zero).",
        placeholders: { count: "Number of active filters, 2 or greater." },
      },
      "comments.loadError": {
        description:
          "Inline error card shown when the thread list fails to load. Suggests " +
          "checking the connection and retrying via the nearby Refresh button.",
      },
      "comments.empty.title": {
        description:
          "Heading of the empty-state card shown when the project has no comments at " +
          "all yet (not filtered — genuinely zero).",
      },
      "comments.empty.body": {
        description:
          "Supporting text under comments.empty.title, telling the user where to add " +
          "a first comment.",
      },
      "comments.noMatch.title": {
        description:
          "Heading of the empty-state card shown when the project has comments, but " +
          "the active filters exclude all of them.",
      },
      "comments.noMatch.clear": {
        description:
          "Button in the no-match empty state that resets every filter, showing the " +
          "full thread list again.",
      },
      "comments.drawer.closeLabel": {
        description:
          "Accessible label for the 'X' icon button that closes the per-cell comments " +
          "drawer in the editor.",
        screenshot: "cell-editor",
      },
      "comments.drawer.noComments": {
        description:
          "Plain inline text shown in the per-cell drawer's thread list when the cell " +
          "has no comments yet. Distinct from comments.empty.title, which is a large " +
          "heading on the full-page thread list.",
        screenshot: "cell-editor",
      },
      "comments.drawer.newThreadHeading": {
        description:
          "Small label above the new-thread composer at the bottom of the per-cell " +
          "drawer.",
        screenshot: "cell-editor",
      },
      "comments.drawer.newThreadPlaceholder": {
        description: "Placeholder text of the new-thread textarea in the per-cell drawer.",
        screenshot: "cell-editor",
      },
      "comments.drawer.post": {
        description:
          "Button that submits the new-thread textarea, creating the first comment of " +
          "a new thread on this cell. Imperative verb naming the act of publishing, " +
          "not a generic 'Add' or 'Save'.",
        screenshot: "cell-editor",
      },
    },
  },
  surfaces: [
    {
      id: "comments",
      title: "Project comments",
      route: "/project/:projectId/comments",
      notes:
        "Full-page thread list: header with title/count/back/refresh, the filter bar " +
        "(search, sort, show-resolved, file/author/participant pickers), and either " +
        "thread cards or an empty state below. The seeded dev project has no comments, " +
        "so this shot shows the empty state — the chrome above it (header + filters) is " +
        "what most of these keys describe.",
    },
  ],
})
