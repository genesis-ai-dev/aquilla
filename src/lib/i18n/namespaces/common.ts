import { defineNamespace } from "./types"

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
