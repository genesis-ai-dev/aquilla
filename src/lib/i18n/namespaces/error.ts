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
    "error.network.contextSuffix": " for this {context}",
    "error.network.badRequest": "The request was invalid{contextSuffix}. Check your input and try again.",
    "error.network.sessionExpired": "Your session expired — sign in again.",
    "error.network.forbidden": "You don't have permission to do that{contextSuffix}.",
    "error.network.notFound": "That item no longer exists{contextSuffix}.",
    "error.network.conflict": "A conflict occurred{contextSuffix} — please refresh and try again.",
    "error.network.gone": "That item has been permanently removed{contextSuffix}.",
    "error.network.tooManyRequests": "Too many requests — please wait a moment and try again.",
    "error.network.serverError": "Something went wrong on the server. Please try again in a moment.",
    "error.network.unknownStatus": "The request failed ({status}). Please try again.",
    "error.network.offline": "You're offline — changes will sync when you reconnect.",
    "error.network.genericFailure": "Something went wrong. Please try again.",
    "error.upload.emptyFile": "That file is empty — pick one with content in it.",
    "error.upload.tooLarge": "That file is {size}MB — the limit is {limit}MB.",
    "error.parseDocument.failed":
      "We couldn't read that file. It may be image-only, encrypted, or not a valid PDF or DOCX.",
    "error.changeset.notAuthorized": "You aren't authorized to view this approval.",
    "error.changeset.notFound": "This changeset couldn't be found.",
    "error.changeset.notApprovable": "This changeset can no longer be approved.",
    "error.monday.loadConnection": "Couldn't load the Monday connection status.",
    "error.monday.startConnection": "Couldn't start the Monday connection.",
    "error.monday.disconnect": "Couldn't disconnect Monday.",
    "error.monday.loadBoards": "Couldn't load your Monday boards.",
    "error.monday.loadBoardStructure": "Couldn't load that board's columns and groups.",
    "error.monday.loadLink": "Couldn't load this project's Monday board link.",
    "error.monday.saveLink": "Couldn't save the Monday board link.",
    "error.monday.updateLink": "Couldn't update the Monday board link.",
    "error.monday.removeLink": "Couldn't remove the Monday board link.",
    "error.monday.analyze": "Couldn't build a board mapping suggestion.",
    "error.monday.sync": "Couldn't push this project to Monday.",
    "error.termbase.publish": "Couldn't share this termbase with the organization.",
    "error.termbase.unpublish": "Couldn't stop sharing this termbase.",
    "error.termbase.listPublished": "Couldn't load the termbases shared in this organization.",
    "error.termbase.listSubscriptions": "Couldn't load this project's termbase subscriptions.",
    "error.termbase.subscribe": "Couldn't subscribe to that termbase.",
    "error.termbase.unsubscribe": "Couldn't unsubscribe from that termbase.",
    "error.termbase.reorder": "Couldn't save the new termbase order.",
  },
  context: {
    _context: {
      description:
        "Failure surfaces — the error boundary, permission-denied alerts, the " +
        "private-browsing storage notice, the 404 page, and the messages our API " +
        "clients throw when a request fails, which land in a toast or a red line " +
        "of text beside the control the user just used. Wording is reassuring " +
        "and non-technical: it tells the user something broke or isn't available " +
        "without blaming them and without exposing internals. In particular these " +
        "strings REPLACE the server's own raw error text, which is untranslated " +
        "and often a developer diagnostic — so never write one as if the reader " +
        "will also see a technical reason next to it.",
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
      "error.network.contextSuffix": {
        description:
          "Trailing clause appended to several error.network.* sentences when the " +
          "caller knows what kind of thing failed (e.g. 'project', 'invite'), e.g. " +
          "' for this project'. Never shown alone — always substituted into another " +
          "key's {contextSuffix} placeholder. Keep the leading space so it reads " +
          "correctly appended to the sentence.",
        placeholders: {
          context: "Short lowercase noun naming what failed, e.g. 'project' or 'member'.",
        },
      },
      "error.network.badRequest": {
        description:
          "Generic message for an HTTP 400 response from any of our fetch helpers " +
          "(sync-worker, auth-worker, agent API) shown inline or in a toast. Non-" +
          "technical — never shows the raw server validation string.",
        placeholders: {
          contextSuffix: "Either empty, or the rendered error.network.contextSuffix string — insert exactly as given, do not add extra spacing.",
        },
      },
      "error.network.sessionExpired": {
        description:
          "Message shown when a request fails with HTTP 401 — the session token is " +
          "no longer valid. Tells the user what to do next (sign in again).",
      },
      "error.network.forbidden": {
        description:
          "Generic message for an HTTP 403 response — the signed-in account isn't " +
          "allowed to perform the action. Non-technical, doesn't blame the user.",
        placeholders: {
          contextSuffix: "Either empty, or the rendered error.network.contextSuffix string — insert exactly as given, do not add extra spacing.",
        },
      },
      "error.network.notFound": {
        description:
          "Generic message for an HTTP 404 response — the requested item is gone " +
          "or was never there.",
        placeholders: {
          contextSuffix: "Either empty, or the rendered error.network.contextSuffix string — insert exactly as given, do not add extra spacing.",
        },
      },
      "error.network.conflict": {
        description:
          "Generic message for an HTTP 409 response — another change landed first. " +
          "Tells the user what to do next (refresh and retry).",
        placeholders: {
          contextSuffix: "Either empty, or the rendered error.network.contextSuffix string — insert exactly as given, do not add extra spacing.",
        },
      },
      "error.network.gone": {
        description:
          "Generic message for an HTTP 410 response — the item was intentionally " +
          "and permanently removed (distinct from 404's 'no longer exists').",
        placeholders: {
          contextSuffix: "Either empty, or the rendered error.network.contextSuffix string — insert exactly as given, do not add extra spacing.",
        },
      },
      "error.network.tooManyRequests": {
        description:
          "Message shown when a request fails with HTTP 429 (rate limited). Tells " +
          "the user what to do next (wait and retry).",
      },
      "error.network.serverError": {
        description:
          "Generic message for an HTTP 5xx response — something failed on our " +
          "servers, not something the user did wrong.",
      },
      "error.network.unknownStatus": {
        description:
          "Fallback message for any HTTP status code without a more specific " +
          "error.network.* message above.",
        placeholders: {
          status: "The raw HTTP status code, e.g. '418'.",
        },
      },
      "error.network.offline": {
        description:
          "Shown when a request fails before reaching the server (browser is " +
          "offline / DNS failure / etc). Reassures the user their change is queued.",
      },
      "error.network.genericFailure": {
        description:
          "Last-resort fallback shown when a caught error can't be classified as " +
          "an HTTP status or an offline failure.",
      },
      "error.upload.tooLarge": {
        description:
          "Shown beside the agent composer's attach-file control when the chosen " +
          "file exceeds the server's size ceiling, before any upload is attempted. " +
          "Both numbers are megabytes; the app formats them, so don't add a unit.",
        placeholders: {
          size: "Size of the chosen file in megabytes, already rounded to one decimal place, e.g. '31.4'.",
          limit: "The maximum allowed size in whole megabytes, e.g. '25'.",
        },
      },
      "error.parseDocument.failed": {
        description:
          "Shown in the rule-import dialog when the server can't extract text " +
          "from an uploaded PDF or DOCX. Names the likely causes because the " +
          "server's own reason is a raw diagnostic we deliberately don't show.",
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
