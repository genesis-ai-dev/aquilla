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
