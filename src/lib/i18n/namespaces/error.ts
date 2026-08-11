import { defineNamespace } from "./types"

export const error = defineNamespace({
  keys: {
    "error.generic.title": "Something went wrong",
    "error.permissionDenied.messageWithRole":
      "You're signed in as {account} — your role on this project is {role}, which " +
      "doesn't have permission to {action}{requiredRoleNote}.",
    "error.permissionDenied.messageWithoutRole":
      "You're signed in as {account}, which doesn't have permission to {action}{requiredRoleNote}.",
    "error.permissionDenied.requiredRoleNote": " (needs {requiredRole})",
    "error.permissionDenied.learnMore": "Learn about permission levels",
    "error.permissionDenied.switchAccountLabel": "Switch account:",
    "error.permissionDenied.switchToAccount": "Switch to {username}",
    "error.permissionDenied.addOrSwitchLabel": "Have another account? Add or switch:",
    "error.privateMode.message":
      "Private browsing is restricting local storage. Audio will stream and play, but " +
      "waveforms and downloads can't be cached — you'll see slower loads on each visit.",
    "error.notFound.title": "Page not found",
    "error.notFound.description": "The link you followed doesn't exist or may have moved.",
    "error.notFound.goHome": "Go home",
  },
  context: {
    _context: {
      description:
        "Failure surfaces — the error boundary, permission-denied alerts, the " +
        "private-browsing storage notice, and the 404 page. Wording is reassuring " +
        "and non-technical: it tells the user something broke or isn't available " +
        "without blaming them and without exposing internals.",
      screenshot: "error-state",
    },
    keys: {
      "error.generic.title": {
        description:
          "Heading of the generic failure panel shown when an unexpected error is " +
          "caught. A short sentence, not a button; sentence case, no trailing period.",
      },
      "error.permissionDenied.messageWithRole": {
        description:
          "Full sentence in the permission-denied alert shown when the signed-in " +
          "account is blocked from an action AND the caller knows the account's role " +
          "on this project. Rendered with <RichMessage> (AQU-511): the account name " +
          "and role are the two facts the user needs from this sentence, so the call " +
          "site wraps each in a font-medium span to keep them visually distinct from " +
          "the surrounding prose. Otherwise reassuring, not clinical — it explains why " +
          "the action is blocked, not that the user did something wrong. Used instead " +
          "of messageWithoutRole when a role is known.",
        placeholders: {
          account: "The signed-in account's display name, optionally followed by its email in parentheses (already formatted by the app, do not add more punctuation around it). Rendered as a font-medium span by the call site — do not add your own emphasis markup around the placeholder.",
          role: "The account's role label on this project, e.g. 'Viewer' or 'Translator'. Rendered as a font-medium span by the call site — do not add your own emphasis markup around the placeholder.",
          action: "Bare verb phrase naming what was blocked, e.g. 'change shared settings'. Lowercase, no trailing punctuation.",
          requiredRoleNote: "Either empty, or the rendered error.permissionDenied.requiredRoleNote string — insert exactly as given, do not add extra spacing.",
        },
      },
      "error.permissionDenied.messageWithoutRole": {
        description:
          "Same permission-denied sentence as messageWithRole, used when the caller's " +
          "role on this project isn't known/resolved, so the role clause is omitted. " +
          "Also rendered with <RichMessage>: the account name is a font-medium span.",
        placeholders: {
          account: "The signed-in account's display name, optionally followed by its email in parentheses (already formatted by the app). Rendered as a font-medium span by the call site — do not add your own emphasis markup around the placeholder.",
          action: "Bare verb phrase naming what was blocked, e.g. 'add members to this project'. Lowercase, no trailing punctuation.",
          requiredRoleNote: "Either empty, or the rendered error.permissionDenied.requiredRoleNote string — insert exactly as given.",
        },
      },
      "error.permissionDenied.requiredRoleNote": {
        description:
          "Trailing parenthetical appended to the permission-denied sentence when a " +
          "minimum role is known, e.g. ' (needs Maintainer or higher)'. Keep the " +
          "leading space and parentheses so it reads correctly appended to the sentence.",
        placeholders: {
          requiredRole: "The minimum role name required for the blocked action, e.g. 'Maintainer or higher'.",
        },
      },
      "error.permissionDenied.learnMore": {
        description:
          "Link below the permission-denied message to the docs page explaining " +
          "permission levels. Opens in a new tab; short link label, not a full sentence.",
      },
      "error.permissionDenied.switchAccountLabel": {
        description:
          "Small label introducing a row of 'Switch to X' buttons for other accounts " +
          "already signed in on this device. Precedes the buttons, not a button itself.",
      },
      "error.permissionDenied.switchToAccount": {
        description:
          "Button that switches the active account to the named already-signed-in " +
          "account, shown as one of several buttons in a row on the permission-denied " +
          "alert. Keep short — it sits beside other account-switch buttons.",
        placeholders: {
          username: "The other account's username/display name.",
        },
      },
      "error.permissionDenied.addOrSwitchLabel": {
        description:
          "Label shown instead of switchAccountLabel when there is no other " +
          "already-signed-in account — invites the user to add one via the account " +
          "switcher control that follows it.",
      },
      "error.privateMode.message": {
        description:
          "Body text of the dismissible top banner shown when the browser's private/" +
          "incognito mode blocks persistent local storage (e.g. Safari Private " +
          "Browsing, Brave Tor windows). Reassures the user that audio still works, " +
          "just without caching, so pages reload more slowly. Non-technical: avoid " +
          "naming the underlying storage API.",
      },
      "error.notFound.title": {
        description:
          "Heading of the 404 'page not found' screen shown for any unmatched route. " +
          "A short sentence, not a button; sentence case, no trailing period.",
      },
      "error.notFound.description": {
        description:
          "One-line explanation under the 404 heading. Reassuring, non-technical — " +
          "the link didn't work, not the user's fault.",
      },
      "error.notFound.goHome": {
        description:
          "Button on the 404 page that navigates back to the app's home/root route. " +
          "Short imperative label.",
      },
    },
  },
  surfaces: [
    {
      id: "error-state",
      title: "Error state",
      // Route changed from "/project/:projectId" during the AQU-511 capture
      // run: that route's failure is one line of muted prose with no heading
      // and no action, so the shot showed none of the layout these strings are
      // written for. The 404 screen renders title-as-heading + description +
      // action button, which the error boundary and permission-denied alert
      // reuse. See scripts/i18n-shots/error.ts.
      route: "/(any unmatched route)",
      notes:
        "Generic failure surface, captured on the 404 screen — the failure state " +
        "that shows the full shape these strings share: title as a heading, one " +
        "line of description under it, and a single short action button. The " +
        "error boundary and the permission-denied alert reuse that layout. " +
        "Wording should be reassuring and non-technical; the title is a heading, " +
        "not a button.",
    },
  ],
})
