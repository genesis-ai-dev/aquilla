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
  },
  context: {
    _context: {
      description:
        "Shared action verbs and status text reused across the whole app — mostly " +
        "buttons in dialog footers and toolbars, so they sit side by side with other " +
        "actions and must stay short and imperative.",
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
          "expected format with an example date. Not a real date — format it the way " +
          "dates are conventionally written in the target language, keeping day, month " +
          "name, and year in that order.",
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
