import { defineNamespace, plural } from "./types"

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
    "comments.mention.noMembers": "No one on this project to mention.",
    "comments.mention.restricted": "No one in your lanes to mention yet.",
    "comments.mention.suggestionsAria": "Project members",
    "comments.composer.editPlaceholder": "Edit comment…",
    "comments.composer.replyPlaceholder": "Leave a reply...",

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
    "comments.resolve.foreignDenied":
      "Only {minRole} and above can resolve a thread someone else started.",
    "comments.status.open": "open",
    "comments.status.resolved": "resolved",
    "comments.stale.badge": "stale",
    "comments.stale.tooltip": "Translation changed since this thread was created",
    "comments.reply.notWired":
      "Replies from this view are not yet wired — open the cell in the editor to reply.",

    // In-thread reply composer (CommentThread.tsx — no @mention hint here)
    "comments.thread.replyPlaceholder": "Leave a reply...",
    "comments.thread.reply": "Reply",
    "comments.thread.closeWithReply": "Close with reply",
    "comments.thread.actionsAria": "Comment actions",
    "comments.thread.resolve": "Resolve thread",
    "comments.thread.reopen": "Reopen thread",
    "comments.thread.copyUrl": "Copy comment URL",
    "comments.thread.enterReply": "to reply",
    "comments.thread.optionEnterResolve": "to reply and resolve",
    "comments.thread.collapse": "Collapse",
    "comments.thread.resolvedSummary": plural({
      one: "{count} resolved comment from {authors}",
      other: "{count} resolved comments from {authors}",
    }),

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
    "comments.page.titleWithProject": "{projectName} — Comments",
    "comments.filterCount.one": "{count} filter",
    "comments.filterCount.other": "{count} filters",
    "comments.loadError": "Failed to load comments. Check your connection and try refreshing.",
    "comments.empty.title": "No comments yet",
    "comments.empty.body": "Comments can be added from the cell menu in the editor.",
    "comments.empty.noneVisible": "No comments",
    "comments.noMatch.title": "No threads match your filters",
    "comments.noMatch.clear": "Clear filters",

    // CommentsDrawer (per-cell comments panel in the editor)
    "comments.drawer.closeLabel": "Close comments",
    "comments.drawer.noComments": "No comments yet.",
    "comments.drawer.loadError": "Couldn't load comments. Existing threads may be missing.",
    "comments.drawer.newThreadHeading": "New thread",
    "comments.drawer.newThreadPlaceholder": "Leave a comment...",
    "comments.drawer.post": "Post",

    // In-app mention inbox (workspace header bell)
    "comments.inbox.title": "Notifications",
    "comments.inbox.unreadCount": "{count} unread",
    "comments.inbox.emptyTitle": "No mentions yet",
    "comments.inbox.empty": "When a teammate @mentions you in a comment, it shows up here.",
    "comments.inbox.markAllRead": "Mark all as read",
    "comments.inbox.markRead": "Mark as read",
    "comments.inbox.markUnread": "Mark unread",
    "comments.inbox.mentionedYou": "{author} mentioned you",
    "comments.inbox.unreadsOnly": "Show unreads only",
    "comments.inbox.actionsAria": "Notification actions",
    "comments.inbox.delete": "Delete notification",
    "comments.inbox.deletedToast": "Notification deleted",
    "comments.inbox.undo": "Undo",
    "comments.inbox.undoneToast": "Undo \"{action}\"",
    "comments.inbox.deleteAll": "Delete all",
    "comments.inbox.deleteAllRead": "Delete all read",
    "comments.inbox.deleteTitle": "Delete notification?",
    "comments.inbox.deleteDescription":
      "This removes the notification from your inbox. The comment stays.",
    "comments.inbox.deleteAllTitle": "Delete all notifications?",
    "comments.inbox.deleteAllDescription":
      "This removes every notification from your inbox. The comments stay.",
    "comments.inbox.deleteAllReadTitle": "Delete read notifications?",
    "comments.inbox.deleteAllReadDescription":
      "This removes notifications you have already read. Unread ones stay, and the comments stay.",
    "comments.inbox.noUnreadTitle": "No unread notifications",
    "comments.inbox.noUnread": "You're caught up.",
    "comments.inbox.unreadBadge": "Unread",
    "comments.inbox.footer": "Mentions in this project.",
    "comments.inbox.openAria": "Notifications",
    "comments.inbox.openUnreadAria": "Notifications, {count} unread",
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
        description: "Empty-state row in the @mention dropdown when no project member matches the query.",
      },
      "comments.mention.noMembers": {
        description:
          "Empty-state row in the @mention dropdown when this project has no other members " +
          "to mention (the signed-in user is not listed).",
      },
      "comments.mention.restricted": {
        description:
          "Empty-state row in the @mention dropdown for a member whose organisation hides the " +
          "project's member list from them: they can only mention people who share a lane " +
          "with them plus the project's maintainers, and none are available yet.",
      },
      "comments.mention.suggestionsAria": {
        description:
          "Accessible name of the @mention suggestion listbox that opens under a comment " +
          "composer. Not visible on screen; announced with the list of project members.",
      },
      "comments.composer.editPlaceholder": {
        description:
          "Placeholder text of the textarea shown when editing an existing comment's " +
          "body in place.",
      },
      "comments.composer.replyPlaceholder": {
        description:
          "Placeholder of the reply field on an existing thread in the full-page " +
          "list. Same wording as comments.thread.replyPlaceholder. Typing @ still " +
          "mentions a project member.",
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
          "Button that marks an open thread resolved. Shown as the toggle in a " +
          "thread card's header and as an item in the thread's … menu. Imperative verb.",
      },
      "comments.reopen": {
        description:
          "Button that reopens a resolved thread. Pairs with comments.resolve as the " +
          "same toggle in two places: a thread card's header, and inside a resolved " +
          "thread. Imperative verb.",
      },
      "comments.resolve.foreignDenied": {
        description:
          "Tooltip on the disabled Resolve / Close with reply / Reopen controls, shown " +
          "when the reader's role is high enough to resolve their OWN threads but not " +
          "one started by somebody else.",
        placeholders: {
          minRole:
            "Plural role noun for the lowest role that may resolve another user's " +
            "thread, already localized (e.g. 'Contributors'). Never a username.",
        },
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
          "Placeholder of the reply field on an existing thread in the per-cell " +
          "drawer. Short prompt, not instructions. Typing @ still mentions a " +
          "project member.",
        screenshot: "cell-editor",
      },
      "comments.thread.reply": {
        description:
          "Accessible name of the arrow button at the bottom right of the reply " +
          "field. Enter sends the reply; Option-Enter or Alt-Enter also resolves " +
          "the thread. Imperative verb.",
        screenshot: "cell-editor",
      },
      "comments.thread.closeWithReply": {
        description:
          "Button that submits the reply text AND resolves the thread in one action. " +
          "Sits beside comments.thread.reply; should read as doing both things, not " +
          "just closing.",
        screenshot: "cell-editor",
      },
      "comments.thread.actionsAria": {
        description:
          "Accessible name of the … button at the top right of a comment thread. " +
          "The menu holds Edit, Resolve thread (or Reopen thread), Copy comment URL, " +
          "and Delete. Not visible.",
      },
      "comments.thread.resolve": {
        description:
          "Menu item that marks this open thread resolved. Longer than " +
          "comments.resolve because it sits in the thread's … menu beside Edit " +
          "and Delete. Imperative.",
        screenshot: "cell-editor",
      },
      "comments.thread.reopen": {
        description:
          "Menu item that reopens a resolved thread. Pairs with " +
          "comments.thread.resolve in the thread's … menu. Imperative.",
        screenshot: "cell-editor",
      },
      "comments.thread.copyUrl": {
        description:
          "Menu item that copies a link to this comment — the editor URL that " +
          "opens the cell and highlights the message. Imperative.",
        screenshot: "cell-editor",
      },
      "comments.thread.enterReply": {
        description:
          "Second half of the reply button's tooltip, after an Enter keycap. " +
          "Reads as 'Enter to reply'. Lowercase, no period.",
      },
      "comments.thread.optionEnterResolve": {
        description:
          "Second half of the reply button's tooltip, after the Option/Alt and " +
          "Enter keycaps. Reads as 'Option Enter to reply and resolve'. Lowercase, " +
          "no period.",
      },
      "comments.thread.collapse": {
        description:
          "Label on an expanded resolved thread that folds it back into the " +
          "summary row. Also the accessible name of the close icon beside it.",
        screenshot: "cell-editor",
      },
      "comments.thread.resolvedSummary": {
        description:
          "Collapsed summary of a resolved thread. Names how many messages it " +
          "holds and who wrote them. Clicking it expands the thread.",
        screenshot: "cell-editor",
        placeholders: {
          count: "Number of messages in the resolved thread. Selects the plural form.",
          authors: "The people who wrote those messages, already joined for the locale (for example 'Keean' or 'Keean and Alice').",
        },
      },
      "comments.filter.searchPlaceholder": {
        description: "Placeholder text of the free-text search box in the thread-list filter bar.",
      },
      "comments.filter.filtersButton": {
        description:
          "Tooltip and accessible name of the funnel icon button that opens the " +
          "filter menu (sort, show-resolved, file, author, participant). The name " +
          "does not change when the menu is open.",
      },
      "comments.filter.sortLabel": {
        description: "Form label beside the sort-order picker in the filter menu.",
      },
      "comments.filter.showResolved": {
        description: "Switch label in the filter menu: include resolved threads in the visible list.",
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
      "comments.empty.noneVisible": {
        description:
          "Heading of the empty-state card when the project has comments, but none " +
          "are visible under the default filters (resolved threads are hidden). Not " +
          "the filtered no-match state — that uses comments.noMatch.title.",
      },
      "comments.noMatch.title": {
        description:
          "Heading of the empty-state card shown when the project has comments, but " +
          "user-applied (non-default) filters exclude all of them.",
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
      "comments.drawer.loadError": {
        description:
          "Inline error shown at the top of the per-cell drawer's thread list when the " +
          "comments feed failed to load. Replaces the 'No comments yet.' empty state so " +
          "a dropped request is never mistaken for deleted comments; warns that the " +
          "threads shown may be incomplete and sits above a Retry button.",
        screenshot: "cell-editor",
      },
      "comments.drawer.newThreadHeading": {
        description:
          "Accessible name of the new-thread field at the bottom of the per-cell " +
          "drawer. Not shown on screen.",
        screenshot: "cell-editor",
      },
      "comments.drawer.newThreadPlaceholder": {
        description:
          "Placeholder of the new-thread field at the bottom of the per-cell drawer. " +
          "Short prompt. Typing @ still mentions a project member.",
        screenshot: "cell-editor",
      },
      "comments.drawer.post": {
        description:
          "Accessible name of the arrow button at the bottom right of the new-thread " +
          "field. It stays an outline icon button until the field has text, then " +
          "fills in. Enter posts the comment. Imperative verb.",
        screenshot: "cell-editor",
      },
      "comments.inbox.title": {
        description: "Heading of the notifications popover opened from the bell in the project header.",
      },
      "comments.inbox.unreadCount": {
        description:
          "Count shown at the right of the notifications heading while mentions are unread. " +
          "{count} is the number.",
        placeholders: { count: "How many mention notifications are still unread." },
      },
      "comments.inbox.emptyTitle": {
        description: "Short heading of the empty notifications popover.",
      },
      "comments.inbox.empty": {
        description:
          "Body under the empty-state heading when nobody has @mentioned the signed-in " +
          "user in a comment on this project.",
      },
      "comments.inbox.markAllRead": {
        description:
          "Item in the notifications ⋯ menu that marks every mention in the inbox as read. " +
          "Disabled when nothing is unread.",
      },
      "comments.inbox.markRead": {
        description:
          "Item in the right-click menu on one notification. Marks that row read without " +
          "opening it. Shown only while the row is unread.",
      },
      "comments.inbox.markUnread": {
        description:
          "Item in the right-click menu on one notification. Marks that row unread again. " +
          "Shown only while the row is already read.",
      },
      "comments.inbox.mentionedYou": {
        description:
          "Line under a notification's place title. Names the person who @mentioned " +
          "the reader. The comment text is a separate line beneath this one, not part " +
          "of the sentence. Example: \"Keean mentioned you\".",
        placeholders: {
          author: "Display name of the person who wrote the mention.",
        },
      },
      "comments.inbox.unreadsOnly": {
        description:
          "Tooltip and accessible name of the filter button at the top right of the " +
          "notifications popover. Pressed, the list shows only unread rows.",
      },
      "comments.inbox.actionsAria": {
        description:
          "Accessible name of the ⋯ button at the top right of the notifications popover. " +
          "The button itself has no visible text.",
      },
      "comments.inbox.delete": {
        description:
          "Item in the right-click menu on one notification. Removes that row from this " +
          "device's inbox immediately. Does not delete the comment. A toast offers undo.",
      },
      "comments.inbox.deletedToast": {
        description:
          "Toast shown after one notification is removed from the inbox. Paired with " +
          "an Undo button. The comment itself stays.",
      },
      "comments.inbox.undoneToast": {
        description:
          "Success toast after Undo (or Ctrl+Z) puts a notification back. {action} is " +
          "the title of the toast that was undone, shown in quotes. A check icon sits " +
          "beside it. The only button is close.",
        placeholders: {
          action: "Title of the toast that was undone, such as Notification deleted.",
        },
      },
      "comments.inbox.undo": {
        description:
          "Button on the notification-deleted toast that puts that notification back " +
          "in the inbox. Ctrl+Z does the same while this button is showing. Afterward " +
          "the button is replaced by the normal close button.",
        maxLength: 16,
      },
      "comments.inbox.deleteAll": {
        description:
          "Item in the notifications ⋯ menu. Removes every notification from this " +
          "device's inbox. Does not delete the comments.",
      },
      "comments.inbox.deleteAllRead": {
        description:
          "Item in the notifications ⋯ menu. Removes notifications that have already " +
          "been read. Unread ones stay. Does not delete the comments.",
      },
      "comments.inbox.deleteTitle": {
        description:
          "Heading of the confirmation dialog before removing one notification from the inbox.",
      },
      "comments.inbox.deleteDescription": {
        description:
          "Body of the confirmation dialog for deleting one notification. Says the " +
          "comment itself is kept.",
      },
      "comments.inbox.deleteAllTitle": {
        description: "Heading of the confirmation dialog before clearing the whole inbox.",
      },
      "comments.inbox.deleteAllDescription": {
        description:
          "Body of the confirmation dialog for deleting every notification. Says the " +
          "comments themselves are kept.",
      },
      "comments.inbox.deleteAllReadTitle": {
        description:
          "Heading of the confirmation dialog before removing notifications that are already read.",
      },
      "comments.inbox.deleteAllReadDescription": {
        description:
          "Body of the confirmation dialog for deleting read notifications. Says unread " +
          "rows and the comments themselves stay.",
      },
      "comments.inbox.noUnreadTitle": {
        description:
          "Heading shown in the notifications list when Show unreads only is on and " +
          "every remaining notification has been read.",
      },
      "comments.inbox.noUnread": {
        description: "Short line under the no-unread heading.",
      },
      "comments.inbox.unreadBadge": {
        description: "Small badge on a notification row that has not been opened yet.",
      },
      "comments.inbox.footer": {
        description:
          "One-line note at the bottom of the notifications popover. Says these rows are " +
          "mentions in the project that is open.",
      },
      "comments.inbox.openAria": {
        description:
          "Accessible name of the notifications bell in the project header when nothing " +
          "is unread. Not visible; the control is a bell icon.",
      },
      "comments.inbox.openUnreadAria": {
        description:
          "Accessible name of the notifications bell when one or more mentions are unread. " +
          "{count} is the number of unread mentions.",
        placeholders: { count: "How many mention notifications are still unread." },
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
