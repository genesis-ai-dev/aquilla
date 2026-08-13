import { defineNamespace, plural } from "./types"

export const common = defineNamespace({
  keys: {
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.delete": "Delete",
    "common.dismiss": "Dismiss",
    "common.retry": "Retry",
    "common.loading": "Loading…",
    "common.edit": "Edit",
    "common.confirm": "Confirm",
    "common.back": "Back",
    "common.next": "Next",
    "common.add": "Add",
    "common.clear": "Clear",
    "common.discard": "Discard",
    "common.saved": "Saved",
    "common.saving": "Saving…",
    "common.none": "None",
    "common.name": "Name",
    "common.email": "Email",
    "common.selectDate": "Select date",
    "common.datePlaceholder": "June 01, 2025",
    "common.breadcrumbNav": "breadcrumb",
    "common.moreBreadcrumbs": "More",
    "common.loadingSpinner": "Loading",

    // — Shared vocabulary and status words (AQU-511 wave 4):
    //   promoted here because two or more namespaces render exactly these
    //   strings, and a translator should be asked for each of them once.
    "common.logIn": "Log in",
    "common.voices": "Voices",
    "common.project": "Project",
    "common.file": "File",
    "common.comments": "Comments",
    "common.cellLabel": "Cell {id}",
    "common.selectAll": "Select all",
    "common.cancelling": "cancelling…",
    "common.transcribing": "Transcribing…",
    "common.synthesizing": "Synthesizing…",
    "common.measuringLengths": "Measuring lengths",
    "common.uploading": "Uploading…",
    "common.uploadFailed": "Upload failed",
    "common.pause": "Pause",
    "common.reset": "Reset",
    "common.preview": "Preview",
    "common.seek": "Seek",
    "common.volume": "Volume",
    "common.noMatches": "No matches",
    "common.readOnlyGit": "Read-only (imported from git)",
    "common.refresh": "Refresh",
    "common.searching": "Searching…",
    "common.stop": "Stop",

    // — Wave-4 namespace dedupe (AQU-511/AQU-832, WS-17): six area agents fanned
    //   out in parallel and independently minted keys for the same English. For
    //   each duplicate below, promoting here was the chosen fix over reuse
    //   because the two (or three) original call sites belong to genuinely
    //   unrelated features with no single natural owner — see each key's note
    //   for the specific surfaces it now serves.
    "common.done": "Done",
    "common.copy": "Copy",
    "common.revoke": "Revoke",
    "common.revoking": "Revoking…",
    "common.restore": "Restore",
    "common.customize": "Customize",
    "common.roleLabel": "Role",
    "common.creating": "Creating…",
    "common.adding": "Adding…",
    "common.expiresOn": "Expires {date}",
    "common.org": "Org",
    "common.thirtyDays": "30 days",
    "common.noExpiry": "No expiry",
    "common.descriptionOptional": "Description (optional)",
    "common.optionalFieldNote": "(optional)",
    "common.general": "General",
    "common.modeLabel": "Mode",
    "common.saveChanges": "Save changes",
    "common.readOnly": "Read-only",

    // — Role vocabulary (AQU-832 wave 3, WS-08): the seven-level role ladder
    //   (src/lib/frontier/roles.ts) generated every display label by string
    //   manipulation (snake_case → spaces → capitalize) and pluralised by
    //   appending a literal "s". Each role's singular/plural display form is
    //   authored as one `plural()` key — CLDR `one` is the singular label
    //   ("Viewer"), `other` is the plural noun ("Viewers"), so a caller who
    //   needs the plural form (e.g. "Viewers cannot perform this action")
    //   asks the catalog for it instead of concatenating "s" onto the
    //   singular. The canonical machine-readable name ("viewer",
    //   "project_lead", …) is NOT translated here — it stays in roles.ts as
    //   a plain string, used for comparisons, sorting, and the wire format
    //   shared with the server.
    "common.role.viewer": plural({ one: "Viewer", other: "Viewers" }),
    "common.role.commenter": plural({ one: "Commenter", other: "Commenters" }),
    "common.role.reviewer": plural({ one: "Reviewer", other: "Reviewers" }),
    "common.role.contributor": plural({ one: "Contributor", other: "Contributors" }),
    "common.role.projectLead": plural({ one: "Project lead", other: "Project leads" }),
    "common.role.maintainer": plural({ one: "Maintainer", other: "Maintainers" }),
    "common.role.owner": plural({ one: "Owner", other: "Owners" }),

    "common.role.viewerDescription": "Read-only access to cells + comments",
    "common.role.commenterDescription": "Read + add comments on cells",
    "common.role.reviewerDescription": "Read + comment + validate cells (no content edits)",
    "common.role.contributorDescription": "Read + comment + edit cell content",
    "common.role.projectLeadDescription": "Contributor + manage members",
    "common.role.maintainerDescription": "Lead + manage roles",
    "common.role.ownerDescription": "Full control",

    // Permission-denial sentence (src/lib/permissions/denial.ts), split so
    // the two embedded role names are translated through the keys above
    // rather than baked into this template as English words.
    "common.role.denialUnknown": "You need at least {minRole} access to do this.",
    "common.role.denialKnown":
      "{currentRole} cannot perform this action — you need at least {minRole} access.",
  },
  context: {
    _context: {
      description:
        "Strings reused across the whole app, so each one is translated once and " +
        "rendered in several places: action verbs, status words, and shared " +
        "vocabulary. Most are buttons in dialog footers and toolbars, sitting side by " +
        "side with other actions, so they must stay short. Each key's own note names " +
        "every surface it appears on — read it, because a word that fits one of them " +
        "may need to fit all of them.",
      screenshot: "confirm-dialog",
      maxLength: 20,
    },
    keys: {
      "common.save": {
        description:
          "Primary button that commits the changes in the current dialog or panel. " +
          "Imperative verb, not a noun ('Save', not 'Saving' or 'Saved').",
      },
      "common.cancel": {
        description:
          "Secondary button that closes a dialog and discards the changes made in it. " +
          "Pairs with Save; the two sit next to each other.",
      },
      "common.close": {
        description:
          "Button that dismisses a panel or dialog that has nothing to commit. Unlike " +
          "Cancel it does not imply discarding work.",
      },
      "common.delete": {
        description:
          "Destructive button that permanently removes the selected item. Should read " +
          "as clearly destructive in the target language.",
      },
      "common.dismiss": {
        description:
          "Button on a toast or inline notice that hides the message. It only hides the " +
          "notice; it does not undo or resolve whatever the notice reported.",
      },
      "common.retry": {
        description:
          "Button offered after a failed operation that attempts the same operation again.",
      },
      "common.loading": {
        description:
          "Placeholder status text shown while content is being fetched. The trailing " +
          "character is a single ellipsis glyph (…), not three periods; keep whatever " +
          "continuation mark is conventional in the target language.",
        screenshot: "cell-editor",
      },
      "common.edit": {
        description:
          "Button or menu item that puts the item the user is looking at into an " +
          "editable state. Imperative verb; it opens editing, it does not save.",
      },
      "common.confirm": {
        description:
          "Button that carries out the action a confirmation dialog has just described. " +
          "It is the affirmative half of a confirm/cancel pair, so it must read as " +
          "'go ahead and do it', not as 'the value is correct'.",
      },
      "common.back": {
        description:
          "Button that returns to the previous step of a multi-step dialog or wizard. " +
          "Movement backwards through a sequence, not browser history and not undo.",
      },
      "common.next": {
        description:
          "Button that advances to the following step of a multi-step dialog or wizard. " +
          "Pairs with Back; the two sit next to each other in the footer.",
      },
      "common.add": {
        description:
          "Button that appends a new entry to the list beside it (a member, a language, " +
          "a term). Adds to a collection; it does not create a new document or project.",
      },
      "common.clear": {
        description:
          "Button that empties a filter, a search box, or a selection, returning it to " +
          "its unset state. It discards a choice, not saved content.",
      },
      "common.discard": {
        description:
          "Destructive-ish button that throws away unsaved edits and leaves the item as " +
          "it was last saved. Stronger than Cancel: Cancel closes, Discard drops work.",
      },
      "common.saving": {
        description:
          "Status text while a write is still in flight, shown wherever the app has " +
          "taken the user's change but not finished storing it: as the label that " +
          "replaces the back-translation Save button mid-write, and as the small " +
          "badge on a recording take that is saved on this device but not yet " +
          "uploaded. Present participle — clearly a status, never the command " +
          "common.save, and not the finished state common.saved.",
        screenshot: "cell-editor",
        maxLength: 14,
      },
      "common.saved": {
        description:
          "Status text confirming that changes have already been persisted — a past " +
          "participle or state word, NOT the imperative 'Save'. Shown briefly beside " +
          "an editor or a settings row after a successful write.",
        screenshot: "cell-editor",
      },
      "common.none": {
        description:
          "The empty option in a picker, and the value shown when a field is unset " +
          "('None' selected). A noun-like placeholder, not the word 'no'.",
        screenshot: "project-settings",
      },
      "common.name": {
        description:
          "Form label and table column heading for the human-readable name of the thing " +
          "being edited or listed (project, organization, team, token).",
        screenshot: "project-settings",
      },
      "common.email": {
        description:
          "Form label and table column heading for a person's email address, in sign-in, " +
          "invite, and member-management forms.",
        screenshot: "project-settings",
      },
      "common.selectDate": {
        description:
          "Accessible name for the icon-only calendar-picker button beside a date input " +
          "(e.g. the project deadline field). Announced by a screen reader for the button; " +
          "there is no visible label, only a calendar icon.",
        screenshot: "project-settings",
      },
      "common.datePlaceholder": {
        description:
          "Placeholder text shown inside an empty date-input field, illustrating the " +
          "expected format with an example date. Not a real date, and NOT a free " +
          "translation: the field's parser (date-picker.tsx) is hard-locked to the " +
          "en-US month-day-year shape ('June 01, 2025') plus a raw ISO date — it " +
          "cannot understand a reordered or foreign-language date, and a misread date " +
          "silently corrupts what gets saved. Translate the surrounding words if the " +
          "target language has an equivalent illustrative convention, but keep the " +
          "unit order month-day-year and keep the month written in English, so a user " +
          "who types the example back gets a date that parses correctly.",
        screenshot: "project-settings",
      },
      "common.breadcrumbNav": {
        description:
          "Accessible landmark name (aria-label) for the breadcrumb trail shown above " +
          "nested pages (e.g. project > settings). Announced by a screen reader; not " +
          "visible text. Conventionally left as the generic term for this UI pattern " +
          "rather than translated literally.",
        screenshot: "project-settings",
      },
      "common.moreBreadcrumbs": {
        description:
          "Screen-reader-only text on the '…' overflow indicator in a breadcrumb trail, " +
          "read when there are more ancestor pages than fit. Not visible; announced " +
          "alongside the ellipsis glyph.",
        screenshot: "project-settings",
      },
      "common.loadingSpinner": {
        description:
          "Accessible name (aria-label) for an icon-only spinning loading indicator — no " +
          "visible caption, just the spinning graphic. Distinct from common.loading, which " +
          "is visible status text with a trailing ellipsis; this is announced once by a " +
          "screen reader for the spinner element itself, so it takes no ellipsis.",
        screenshot: "cell-editor",
      },
      "common.logIn": {
        description:
          "The sign-in affordance, in all three places it appears: the button shown in " +
          "place of the account switcher when nobody is signed in (visible label and " +
          "accessible name), and the inline text-button that switches an auth form from " +
          "sign-up to sign-in in both the account dialog and the invite-landing page. " +
          "Imperative verb phrase.",
        screenshot: "auth",
      },
      "common.voices": {
        description:
          "The set of speaking voices configured for a project — TTS configurations and " +
          "cloned voices. Used both as the left-dock tab label that opens the voices panel " +
          "and as that panel's own heading. Plural noun; the tab is in a narrow rail.",
        screenshot: "audio-studio",
      },
      "common.project": {
        description:
          "The word for a translation project, as a standalone label: the scope option that " +
          "widens a search or a comment thread to the whole project, and the noun before a " +
          "project id in a captured-context line. Noun, not a verb.",
        screenshot: "search",
      },
      "common.file": {
        description:
          "The word for one imported file, as a standalone label: the scope option that " +
          "narrows a search to the open file, the label beside a file picker, and the noun " +
          "before a file id in a captured-context line.",
        screenshot: "search",
      },
      "common.comments": {
        description:
          "Heading over a list of comment threads — both the full-page thread list and the " +
          "narrow per-cell drawer, so it must fit a narrow column. Comments are team " +
          "discussion about a translation, not footnotes in the text.",
        screenshot: "comments",
      },
      "common.cellLabel": {
        description:
          "Identifies one cell by its raw id, used where no human-readable scripture " +
          "reference is available: on an outbox row beside the timestamp, and as the " +
          "fallback scope label on a comment thread. 'Cell' is Aquilla's unit of " +
          "translation — one verse, line, or segment.",
        screenshot: "workspace-nav",
        placeholders: {
          id: "The cell's id, shortened, or '?' when even that is unavailable.",
        },
      },
      "common.selectAll": {
        description:
          "Small link-styled button that ticks every row in the list below it — every file " +
          "in an assignment group, every cell in a replace preview. Imperative; pairs with " +
          "common.clear, which replaces it once everything is ticked.",
        screenshot: "search",
      },
      "common.cancelling": {
        description:
          "Status text that replaces a cancel/stop button once the user has asked to stop " +
          "but in-flight work is still finishing. Deliberately lowercase in English because " +
          "it sits mid-row as a quiet aside; follow whatever the target language does for " +
          "such inline status text.",
        screenshot: "audio-studio",
        maxLength: 18,
      },
      "common.transcribing": {
        description:
          "Status text while speech-to-text is running: on the disabled menu item for a " +
          "single line, and on the progress banner for a whole-file batch. " +
          "Present-participle status, not a command.",
        screenshot: "audio-studio",
      },
      "common.synthesizing": {
        description:
          "Status text while text-to-speech is generating audio: on the disabled menu item " +
          "for a single line, and on the progress banner for a whole-file batch. " +
          "Present-participle status, not a command.",
        screenshot: "audio-studio",
      },
      "common.measuringLengths": {
        description:
          "Status text on the batch progress banner while the app reads each existing " +
          "recording just to find out how long it is (its duration) — no audio is " +
          "changed. Sits in the same slot as common.transcribing and " +
          "common.synthesizing. 'Lengths' means durations in seconds, not physical " +
          "size. Present-participle status, not a command.",
        screenshot: "audio-studio",
      },
      "common.uploading": {
        description:
          "Transient status while a chosen or recorded media file is being sent to storage. " +
          "Present participle; the trailing character is a single ellipsis glyph (…).",
        screenshot: "audio-studio",
      },
      "common.uploadFailed": {
        description:
          "Short state phrase shown when storing a chosen media file failed — audio or " +
          "video. The underlying error, when there is one, appears beneath it. Not a " +
          "sentence; no final period.",
        screenshot: "audio-studio",
      },
      "common.pause": {
        description:
          "Label, tooltip and accessible name of a transport button while audio is playing; " +
          "pressing it halts playback where it is, without rewinding. Imperative verb, " +
          "shown in place of Play.",
        screenshot: "audio-studio",
      },
      "common.reset": {
        description:
          "Button that puts a control back to its default: clears every active filter, or " +
          "discards a crop back to the full clip. Imperative, and sometimes rendered at " +
          "11px beside an icon, so it must stay to one short word.",
        screenshot: "comments",
        maxLength: 12,
      },
      "common.preview": {
        description:
          "Button that plays a clip back so the user can hear it before committing — a crop " +
          "selection, or an attached reference recording. Imperative verb; swaps to " +
          "common.pause while it is playing.",
        screenshot: "audio-studio",
      },
      "common.seek": {
        description:
          "Accessible name (never visible) of a draggable audio progress control — the " +
          "waveform slider in a cell and the progress line across the transport bar. " +
          "Dragging it moves the playback position. The audio sense of 'seek', not " +
          "searching.",
        screenshot: "audio-studio",
      },
      "common.volume": {
        description:
          "Accessible name (never visible) of a playback volume control — the speaker " +
          "button that opens the slider, and the slider itself. A noun.",
        screenshot: "audio-studio",
      },
      "common.noMatches": {
        description:
          "Empty state shown when a filter query matches nothing in the list below — a " +
          "voice picker, a voice library. No trailing period in the English source.",
        screenshot: "audio-studio",
      },
      "common.readOnlyGit": {
        description:
          "Explains that the open project came from a Git repository and cannot be written " +
          "to from Aquilla: shown as the AI-draft button's tooltip and in place of the " +
          "comment composer. 'git' is the tool's name and stays as-is.",
        screenshot: "editor-table",
        maxLength: 40,
      },
      "common.refresh": {
        description:
          "Button that re-fetches what the panel is showing from the server — a thread " +
          "list, a generated back-translation. Imperative, and sometimes in very little " +
          "room.",
        screenshot: "comments",
        maxLength: 12,
      },
      "common.searching": {
        description:
          "Transient status shown in place of results while a search request is in flight — " +
          "the search dock and dialog, and the @mention dropdown. Present participle; the " +
          "trailing character is a single ellipsis glyph (…).",
        screenshot: "search",
      },
      "common.stop": {
        description:
          "Imperative button that halts something already running: a recording in progress, " +
          "or playback of a take. Distinct from Pause in English only by convention — use " +
          "whichever verb your language uses for 'stop', not 'pause'.",
        screenshot: "audio-studio",
      },
      "common.done": {
        description:
          "Closing button on a dialog that has nothing left to confirm — the org-member " +
          "revoke-access dialog once access is revoked, the API-tokens dialog's close " +
          "button, and the last step of the product tour. Unlike common.close it marks a " +
          "flow as finished, not merely dismissed.",
        screenshot: "project-settings",
      },
      "common.copy": {
        description:
          "Button that copies a value (an invite link, an org-invite link) to the " +
          "clipboard. Swaps to a 'Copied' confirmation on click.",
        screenshot: "project-settings",
      },
      "common.revoke": {
        description:
          "Destructive button that immediately invalidates a credential or link — a " +
          "personal API token, or a project invite link.",
        screenshot: "project-settings",
      },
      "common.revoking": {
        description:
          "Status text that replaces common.revoke while the revoke request is in " +
          "flight — an org member's access-revoke dialog, a personal API token.",
        screenshot: "project-settings",
      },
      "common.restore": {
        description:
          "Button that un-archives something back to its active state — an archived " +
          "project, or an archived target-language lane.",
        screenshot: "project-settings",
      },
      "common.customize": {
        description:
          "Button that opens a customization surface — the project-overview stats " +
          "picker, or the editor's default-AI-instructions nudge banner.",
        screenshot: "project-settings",
      },
      "common.roleLabel": {
        description:
          "Field label above a role-picker select — the per-project invite-link role " +
          "picker, wherever it is rendered.",
        screenshot: "project-settings",
      },
      "common.creating": {
        description:
          "Busy-state label on a submit button while a create request is in flight — " +
          "creating an organization, a project, or a project invite link.",
        screenshot: "project-settings",
      },
      "common.adding": {
        description:
          "Busy-state label on a submit button while an add request is in flight — " +
          "adding a team member, a target-language lane, or importing a drafted rule.",
        screenshot: "project-settings",
      },
      "common.expiresOn": {
        description:
          "Standalone row text on an item with an expiry — a personal API token, or a " +
          "project invite link — stating the already-formatted date it stops working.",
        placeholders: {
          date: "The already-formatted expiry date, e.g. 'Aug 12, 2026'.",
        },
        screenshot: "project-settings",
      },
      "common.org": {
        description:
          "Short label abbreviating 'Organization' — the org-name table-column heading " +
          "on the org project list, and the scope badge on an org-level translation rule.",
        screenshot: "project-settings",
      },
      "common.thirtyDays": {
        description:
          "A duration option in an expiry picker — a project invite link's expiry " +
          "dropdown, and a personal API token's expiry dropdown.",
        screenshot: "project-settings",
      },
      "common.noExpiry": {
        description:
          "The 'never expires' option in an expiry picker — a project invite link's " +
          "expiry dropdown, and a personal API token's expiry dropdown.",
        screenshot: "project-settings",
      },
      "common.descriptionOptional": {
        description:
          "Field label for an optional free-text description — a team's create/edit " +
          "form, and a translation rule's editor form.",
        screenshot: "project-settings",
      },
      "common.optionalFieldNote": {
        description:
          "Small trailing qualifier appended after a field label to mark it as not " +
          "required — the AI-provider endpoint form, and the invite-link email field.",
        screenshot: "project-settings",
      },
      "common.general": {
        description:
          "Settings-group heading for the catch-all first section of a settings nav — " +
          "personal Preferences, and per-project Project Settings.",
        screenshot: "project-settings",
      },
      "common.modeLabel": {
        description:
          "Field label above a mode-picker select — a personal API token's Ask/Act " +
          "mode, and a translation rule's Forbidden/Required/Must-match mode.",
        screenshot: "project-settings",
      },
      "common.saveChanges": {
        description:
          "Primary button that commits pending edits on a settings-style form — the " +
          "Project Settings save bar, and the translation-rule editor.",
        screenshot: "project-settings",
      },
      "common.readOnly": {
        description:
          "Badge shown in place of an edit control when the caller's role doesn't meet " +
          "the floor required to act — an org-level translation rule, and the " +
          "terminology review queue.",
        screenshot: "project-settings",
      },
      "common.role.viewer": {
        description:
          "The lowest role on the seven-level access ladder: read-only, no comments or " +
          "edits. Shown as a role-picker option label (share links, project/org member " +
          "lists) and, in its plural form, as the subject of a permission-denial sentence " +
          "('Viewers cannot perform this action'). The 'one' form is the singular label " +
          "used everywhere a single role name is shown; 'other' is the plural noun.",
        screenshot: "project-settings",
      },
      "common.role.commenter": {
        description:
          "Role one step above viewer: read + add comments, no validation or content " +
          "edits. Same singular/plural label usage as common.role.viewer.",
        screenshot: "project-settings",
      },
      "common.role.reviewer": {
        description:
          "Role that can read, comment, and validate cells but not edit content — " +
          "translation consultants approving work without changing it. Same " +
          "singular/plural label usage as common.role.viewer.",
        screenshot: "project-settings",
      },
      "common.role.contributor": {
        description:
          "Role that can read, comment, and edit cell content. Same singular/plural " +
          "label usage as common.role.viewer.",
        screenshot: "project-settings",
      },
      "common.role.projectLead": {
        description:
          "Operational-PM role: contributor privileges plus managing project members, " +
          "but not managing roles. Two words in English ('Project lead'); keep the " +
          "second word lowercase unless the target language's title-casing rules call " +
          "for otherwise. Same singular/plural label usage as common.role.viewer.",
        screenshot: "project-settings",
      },
      "common.role.maintainer": {
        description:
          "Role that can manage members and roles on a project. Same singular/plural " +
          "label usage as common.role.viewer.",
        screenshot: "project-settings",
      },
      "common.role.owner": {
        description:
          "The highest role: full control. Same singular/plural label usage as " +
          "common.role.viewer.",
        screenshot: "project-settings",
      },
      "common.role.viewerDescription": {
        description:
          "One-line summary of what the viewer role can do, shown beside its name in " +
          "every role picker (share link, project member, org member).",
        screenshot: "project-settings",
      },
      "common.role.commenterDescription": {
        description: "One-line summary of what the commenter role can do, shown in role pickers.",
        screenshot: "project-settings",
      },
      "common.role.reviewerDescription": {
        description: "One-line summary of what the reviewer role can do, shown in role pickers.",
        screenshot: "project-settings",
      },
      "common.role.contributorDescription": {
        description: "One-line summary of what the contributor role can do, shown in role pickers.",
        screenshot: "project-settings",
      },
      "common.role.projectLeadDescription": {
        description: "One-line summary of what the project-lead role can do, shown in role pickers.",
        screenshot: "project-settings",
      },
      "common.role.maintainerDescription": {
        description: "One-line summary of what the maintainer role can do, shown in role pickers.",
        screenshot: "project-settings",
      },
      "common.role.ownerDescription": {
        description: "One-line summary of what the owner role can do, shown in role pickers.",
        screenshot: "project-settings",
      },
      "common.role.denialUnknown": {
        description:
          "Explains why a gated action is disabled when the caller's current role isn't " +
          "known (e.g. a local, unsynced project) — only the remedy is stated. Shown as a " +
          "tooltip or inline message on a disabled control.",
        placeholders: {
          minRole: "The minimum role name required, already localized (e.g. 'Contributor').",
        },
      },
      "common.role.denialKnown": {
        description:
          "Explains why a gated action is disabled, naming both the caller's current role " +
          "(as the plural role noun, addressing the whole class of users with that role) " +
          "and the minimum role required. Shown as a tooltip or inline message on a " +
          "disabled control.",
        placeholders: {
          currentRole: "The caller's current role name, already localized and pluralized (e.g. 'Viewers').",
          minRole: "The minimum role name required, already localized (e.g. 'Contributor').",
        },
      },
    },
  },
  surfaces: [
    {
      id: "cell-editor",
      title: "Cell editor",
      route: "/project/:projectId",
      notes:
        "The source/target editing table. Strings here appear as inline controls and " +
        "status text next to translation content, competing for horizontal space.",
    },
    {
      id: "confirm-dialog",
      title: "Confirmation dialog",
      route: "/project/:projectId",
      notes:
        "Modal confirm/cancel pattern. The action verbs are buttons sitting side by " +
        "side; keep them short and imperative.",
    },
    {
      id: "project-settings",
      title: "Project settings",
      route: "/project/:projectId/settings",
      notes:
        "Settings surface, including the language switcher. Labels are form labels " +
        "above or beside their control and have more room than nav or button text.",
    },
  ],
})
