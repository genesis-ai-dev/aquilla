import { defineNamespace } from "./types"

export const dialog = defineNamespace({
  keys: {
    "dialog.confirmCheckboxDefault": "I understand this action.",
    "dialog.assign.title": "Assign work",
    "dialog.assign.scopeLabel": "Scope",
    "dialog.assign.scope.selection": "Current selection",
    "dialog.assign.scope.allVerses": "All verses in file",
    "dialog.assign.scope.entireFile": "Entire file",
    "dialog.assign.scope.books": "Books (files)",
    "dialog.assign.loadingChapters": "Loading chapters…",
    "dialog.assign.loadingSections": "Loading sections…",
    "dialog.assign.noChaptersFound": "No chapters found in this file.",
    "dialog.assign.noSectionsFound": "No sections found in this file.",
    "dialog.assign.error.selectChapter": "Select at least one chapter.",
    "dialog.assign.error.selectSection": "Select at least one section.",
    "dialog.assign.laneLabel": "Language lane",
    "dialog.assign.defaultLaneFallback": "Default language",
    "dialog.assign.laneDescription":
      "Routes this work to a language lane. Restricting who {can} edit a lane is " +
      "separate (staffing).",
    "dialog.assign.filesLabel": "Files / books",
    "dialog.assign.filesDescription":
      "Files sharing a season/testament are grouped — use \"Select all\" to assign a " +
      "whole season in one action.",
    "dialog.assign.assigneeLabel": "Assign to",
    "dialog.assign.selectMemberPlaceholder": "Select member…",
    "dialog.assign.assigneeSelfSuffix": "{username} (you)",
    "dialog.assign.selfAssignDescription":
      "Self-assignment is on — you can claim this work for yourself. Only leads and " +
      "maintainers can assign work to someone else.",
    "dialog.assign.deadlineLabel": "Deadline (optional)",
    "dialog.assign.deadlineBatchDescription":
      "Applies to every file selected above — one deadline for the whole batch.",
    "dialog.assign.noteLabel": "Note (optional)",
    "dialog.assign.notePlaceholder": "Any context for the assignee…",
    "dialog.assign.submit": "Assign",
    "dialog.assign.error.selectMember": "Select a member.",
    "dialog.assign.error.notProjectMember": "You can only assign work to a project member.",
    "dialog.assign.error.selfOnly": "You can only assign work to yourself.",
    "dialog.assign.error.selectFile": "Select at least one book/file.",
    "dialog.assign.error.noFileOpen": "No file open.",
    "dialog.assign.error.noRouteFile": "No file available for routing.",
    "dialog.assign.error.unknown": "Unknown error",
    "dialog.assign.error.bulkFailed": "{failed} of {total} assignment(s) failed",
    "dialog.assign.error.bulkSucceededSuffix": " ({succeeded} succeeded)",
  },
  context: {
    _context: {
      description:
        "Generic confirm/assign modals: ConfirmActionDialog (a reusable destructive- or " +
        "neutral-action confirmation with a required acknowledgement checkbox) and " +
        "AssignModal (the work-assignment dialog opened from the workspace toolbar or a " +
        "file/lane row). Action verbs sit as buttons side by side in the dialog footer, " +
        "so keep them short and imperative.",
      screenshot: "confirm-dialog",
      maxLength: 24,
    },
    keys: {
      "dialog.confirmCheckboxDefault": {
        description:
          "Default label of the acknowledgement checkbox in ConfirmActionDialog, used " +
          "whenever the caller doesn't supply a more specific one. The user must check " +
          "this before the confirm button becomes clickable, so it should read as a " +
          "generic 'I've read this and accept the consequences' statement.",
        maxLength: 80,
      },
      "dialog.assign.title": {
        description:
          "Heading of the AssignModal dialog, next to a check-user icon. Names the " +
          "action the whole dialog performs.",
        screenshot: "assign-modal",
      },
      "dialog.assign.scopeLabel": {
        description:
          "Form label above the scope selector — what portion of the project this " +
          "assignment covers (current selection, whole file, chapters, or files).",
        screenshot: "assign-modal",
      },
      "dialog.assign.scope.selection": {
        description:
          "Scope option: the cells currently selected in the editor. Shown with a " +
          "count suffix like '(3)' appended outside this string.",
        screenshot: "assign-modal",
      },
      "dialog.assign.scope.allVerses": {
        description:
          "Scope option label used when the active file is a Bible text (USFM/eBible/" +
          "etc.): assign every verse in the currently open file.",
        screenshot: "assign-modal",
      },
      "dialog.assign.scope.entireFile": {
        description:
          "Scope option label used when the active file is NOT a Bible text: assign " +
          "the whole currently open file. Neutral wording for non-scripture imports.",
        screenshot: "assign-modal",
      },
      "dialog.assign.scope.books": {
        description:
          "Scope option: assign one or more whole files/books at once, grouped by " +
          "season/testament in the picker below.",
        screenshot: "assign-modal",
      },
      "dialog.assign.laneLabel": {
        description:
          "Form label above the target-language lane selector, shown only on " +
          "projects that have extra translation lanes beyond the default.",
        screenshot: "assign-modal",
      },
      "dialog.assign.defaultLaneFallback": {
        description:
          "Label for the default ('') lane option in the lane selector, used only " +
          "when the project's own default target-language name couldn't be resolved. " +
          "Normal case shows the actual language name instead (e.g. 'Portuguese').",
        screenshot: "assign-modal",
      },
      "dialog.assign.laneDescription": {
        description:
          "Helper text under the language-lane selector, clarifying that choosing a " +
          "lane here only routes the WORK to that lane — it does not control who is " +
          "allowed to edit it (that's a separate staffing setting). Rendered with " +
          "RichMessage: the emphasis on the modal verb is the entire point of the " +
          "sentence — it distinguishes 'assigning work' from 'gating edit rights', and " +
          "without it the sentence reads as a truism ('restricting who edits is " +
          "separate from restricting who edits').",
        screenshot: "assign-modal",
        placeholders: {
          can: "Unusual placeholder: NOT a data value. It stands for the word 'can' " +
            "itself, always rendered in English inside <em> by the call site (the app " +
            "does not have a per-locale translation of just this one word). When " +
            "translating the surrounding sentence, place {can} at the point in your " +
            "own sentence where the permission/ability concept falls — the emphasis " +
            "will visually land there even though its literal text stays English. If " +
            "your language's grammar makes that placement awkward, {can} may be " +
            "omitted; the sentence still reads correctly without it, just without the " +
            "emphasis.",
        },
      },
      "dialog.assign.filesLabel": {
        description:
          "Form label above the file/book picker, shown when scope is 'books'.",
        screenshot: "assign-modal",
      },
      "dialog.assign.filesDescription": {
        description:
          "Helper text explaining that files sharing a season/testament are grouped " +
          "in the picker, and pointing at the group's 'Select all' toggle as the " +
          "one-click way to assign a whole season. The quoted phrase inside must match " +
          "whatever this namespace's 'Select all' toggle reads as in translation " +
          "(shared with common.clear for the toggled-off state).",
        screenshot: "assign-modal",
      },
      "dialog.assign.assigneeLabel": {
        description: "Form label above the assignee picker.",
        screenshot: "assign-modal",
      },
      "dialog.assign.selectMemberPlaceholder": {
        description:
          "Placeholder option in the assignee dropdown before a member is chosen. " +
          "Only shown when the caller may assign to anyone (not self-assign mode).",
        screenshot: "assign-modal",
      },
      "dialog.assign.assigneeSelfSuffix": {
        description:
          "The only option in the assignee dropdown when self-assignment mode is " +
          "active — the caller's own name with a '(you)' qualifier so it's clear the " +
          "picker is locked to them.",
        screenshot: "assign-modal",
        placeholders: {
          username: "The current user's own display name.",
        },
      },
      "dialog.assign.selfAssignDescription": {
        description:
          "Helper text shown under the assignee field when self-assignment mode is " +
          "on, explaining why the picker is locked and who could assign to others " +
          "instead.",
        screenshot: "assign-modal",
      },
      "dialog.assign.deadlineLabel": {
        description: "Form label above the optional deadline date picker.",
        screenshot: "assign-modal",
      },
      "dialog.assign.deadlineBatchDescription": {
        description:
          "Helper text shown under the deadline field only when scope is 'books', " +
          "clarifying that one deadline applies to every file in the batch.",
        screenshot: "assign-modal",
      },
      "dialog.assign.noteLabel": {
        description: "Form label above the optional free-text note field.",
        screenshot: "assign-modal",
      },
      "dialog.assign.notePlaceholder": {
        description:
          "Placeholder text inside the empty note textarea, suggesting what to write.",
        screenshot: "assign-modal",
      },
      "dialog.assign.submit": {
        description:
          "Primary footer button that submits the assignment. Imperative verb naming " +
          "the action, not a generic 'Save' — pairs with Cancel beside it.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.selectMember": {
        description:
          "Inline validation error when submitting without an assignee chosen.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.notProjectMember": {
        description:
          "Inline validation error when the selected assignee turns out not to be a " +
          "project member (defense-in-depth check; the picker already filters these " +
          "out in normal use).",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.selfOnly": {
        description:
          "Inline validation error when a below-lead member (self-assign mode) tries " +
          "to submit an assignment to someone other than themselves.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.selectFile": {
        description:
          "Inline validation error when submitting the 'books' scope with no files " +
          "checked.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.noFileOpen": {
        description:
          "Inline validation error when the 'selection' or 'verses' scope is chosen " +
          "but no file is currently open in the editor.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.noRouteFile": {
        description:
          "Inline validation error in the rare case no file can be resolved to route " +
          "the assignment event through. Should not normally be reachable by a user.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.unknown": {
        description:
          "Fallback inline error text when the assignment submission throws something " +
          "that isn't a recognized error type.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.bulkFailed": {
        description:
          "Inline error summarizing a partially- or fully-failed bulk (books-scope) " +
          "assignment: how many of the total file assignments failed. May be followed " +
          "immediately by dialog.assign.error.bulkSucceededSuffix and then the first " +
          "failure's own error text.",
        screenshot: "assign-modal",
        placeholders: {
          failed: "Count of file assignments that failed, as a plain number.",
          total: "Total count of file assignments attempted, as a plain number.",
        },
      },
      "dialog.assign.error.bulkSucceededSuffix": {
        description:
          "Optional trailing clause appended right after dialog.assign.error." +
          "bulkFailed when at least one file in the batch DID succeed — softens the " +
          "error by noting partial success. Keep the parentheses and leading space so " +
          "it reads naturally appended to the sentence before it.",
        screenshot: "assign-modal",
        placeholders: {
          succeeded: "Count of file assignments that succeeded, as a plain number.",
        },
      },
      "dialog.assign.loadingChapters": {
        description:
          "Transient status text while the chapter list for the active file loads, shown " +
          "beside a spinner. Used when the file is a Bible text.",
        screenshot: "assign-modal",
      },
      "dialog.assign.loadingSections": {
        description:
          "The same status as dialog.assign.loadingChapters, for a file that is not a Bible " +
          "text and is divided into sections instead of chapters.",
        screenshot: "assign-modal",
      },
      "dialog.assign.noChaptersFound": {
        description:
          "Empty-state message when the active Bible file has no chapters to pick from.",
        screenshot: "assign-modal",
      },
      "dialog.assign.noSectionsFound": {
        description:
          "Empty-state message when the active non-scripture file has no sections to pick " +
          "from.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.selectChapter": {
        description:
          "Inline validation error when the chapters scope is chosen but no chapter is " +
          "checked. Full sentence.",
        screenshot: "assign-modal",
      },
      "dialog.assign.error.selectSection": {
        description:
          "The same validation error for a non-scripture file, where the unit is a section " +
          "rather than a chapter.",
        screenshot: "assign-modal",
      },
    },
  },
  surfaces: [
    {
      id: "assign-modal",
      title: "Assign work modal",
      route: "/project/:projectId",
      notes:
        "AssignModal opened from the workspace toolbar: scope selector, optional " +
        "language-lane selector, scope-specific picker (files/chapters), assignee " +
        "picker, deadline, and note. Field labels and helper text sit above/below " +
        "narrow form controls stacked in a single-column dialog.",
    },
  ],
})
