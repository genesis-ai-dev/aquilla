import { defineNamespace } from "./types"

/**
 * `projectDecisions` namespace (AQU-1691): the decision log.
 *
 * `projectDecisions.*` is the "Project decisions" card in Settings → General
 * → Languages, which lists the answers a team gave to Autopilot's questions.
 * `projectDecisions.card.*` is what an Autopilot question card adds when its
 * answer becomes one of these decisions.
 */
export const projectDecisions = defineNamespace({
  keys: {
    // ── Settings card ──
    "projectDecisions.title": "Project decisions",
    "projectDecisions.description":
      "Answers your team gave to Autopilot's questions. Autopilot follows each one in every later draft.",
    "projectDecisions.empty": "No decisions yet. When someone answers a question from Autopilot, it appears here.",
    "projectDecisions.scope.project": "Whole project",
    "projectDecisions.scope.passage": "{from} to {to}",
    "projectDecisions.scope.about": "About {entity}",
    "projectDecisions.byline": "{author} · {date}",
    "projectDecisions.editAriaLabel": "Edit {key}",
    "projectDecisions.remove": "Remove",
    "projectDecisions.removeAriaLabel": "Remove {key}",
    "projectDecisions.removeConfirm": "Remove this decision? Autopilot stops following it.",
    "projectDecisions.field.value": "Decision",
    "projectDecisions.field.book": "Book",
    "projectDecisions.field.from": "From verse",
    "projectDecisions.field.to": "To verse",
    "projectDecisions.field.entity": "About",
    "projectDecisions.field.note": "Note",
    "projectDecisions.field.scopeHint":
      "Leave the book and verses empty for the whole project. Write a book as a code such as ACT, and a verse as ACT 16:10.",
    "projectDecisions.invalid": "This decision can't be saved. Check the book code and the verses.",
    "projectDecisions.saved": "Decision saved.",
    "projectDecisions.removed": "Decision removed.",
    "projectDecisions.error.conflict": "Someone else changed the project settings. Try again.",
    "projectDecisions.error.offline": "You're offline. Reconnect to change project decisions.",
    "projectDecisions.error.permission": "Only a maintainer can change project decisions.",
    "projectDecisions.error.failed": "The project decisions could not be saved.",

    // ── Autopilot question card ──
    "projectDecisions.card.durable": "Your answer becomes a project decision. Autopilot follows it in every later draft.",
    "projectDecisions.card.otherAnswer": "Or write your own answer",
    "projectDecisions.card.needsMaintainer":
      "Only a maintainer can answer this question, because the answer changes the Language profile.",
    "projectDecisions.card.reason.notStorable":
      "This answer doesn't fit the Language profile. Choose one of the answers above, or change the profile in Settings.",
    "projectDecisions.card.reason.tooLong": "This answer is too long to keep as a project decision.",
    "projectDecisions.card.reason.full":
      "The project already keeps as many decisions as it can. Remove one in Settings, then answer again.",
  },
  context: {
    _context: {
      description:
        "The decision log. Autopilot (an AI drafting assistant) sometimes asks the team a " +
        "question it cannot answer alone, such as 'Is Andrew older or younger than Peter?'. " +
        "The answer is kept as a 'project decision', and Autopilot follows it in every draft " +
        "after that. The 'Project decisions' card in Settings lists these decisions; " +
        "maintainers can edit or remove them. The projectDecisions.card.* strings appear on " +
        "the question card itself, in Autopilot's activity panel. Decision keys such as " +
        "'kin.andrew-peter.relative-age' and book codes such as ACT are data: never translate them.",
    },
    keys: {
      "projectDecisions.title": { description: "Title of the settings card that lists the project's decisions." },
      "projectDecisions.description": { description: "One sentence under the card's title." },
      "projectDecisions.empty": { description: "Shown in the card while the project has no decisions." },
      "projectDecisions.scope.project": {
        description: "Where a decision applies: everywhere in the project. Short phrase in a list row.",
        maxLength: 30,
      },
      "projectDecisions.scope.passage": {
        description: "Where a decision applies: a range of Bible verses.",
        placeholders: { from: "First verse, e.g. 'ACT 16:10'. Never translated.", to: "Last verse, e.g. 'ACT 16:17'." },
      },
      "projectDecisions.scope.about": {
        description: "Who or what a decision is about.",
        placeholders: { entity: "A person or thing, as the team typed it, e.g. 'Andrew'." },
      },
      "projectDecisions.byline": {
        description: "Who made a decision and when, under each decision in the list.",
        placeholders: { author: "A username.", date: "A date, already formatted for the reader's language." },
      },
      "projectDecisions.editAriaLabel": {
        description: "Accessible name of the Edit button on one decision.",
        placeholders: { key: "The decision's key, e.g. 'render.the-twelve'. Never translated." },
      },
      "projectDecisions.remove": { description: "Button that removes one decision.", maxLength: 16 },
      "projectDecisions.removeAriaLabel": {
        description: "Accessible name of the Remove button on one decision.",
        placeholders: { key: "The decision's key, e.g. 'render.the-twelve'. Never translated." },
      },
      "projectDecisions.removeConfirm": {
        description: "Question shown before a decision is removed, above Remove and Cancel buttons.",
      },
      "projectDecisions.field.value": { description: "Label of the field holding the decision itself, e.g. 'younger'." },
      "projectDecisions.field.book": { description: "Label of the field for a Bible book code, e.g. ACT." },
      "projectDecisions.field.from": { description: "Label of the field for the first verse the decision applies to." },
      "projectDecisions.field.to": { description: "Label of the field for the last verse the decision applies to." },
      "projectDecisions.field.entity": {
        description: "Label of the field for who or what the decision is about, e.g. 'Andrew'.",
      },
      "projectDecisions.field.note": { description: "Label of a free-text note on the decision." },
      "projectDecisions.field.scopeHint": {
        description: "Hint under the book and verse fields. Keep 'ACT' and 'ACT 16:10' exactly.",
      },
      "projectDecisions.invalid": { description: "Error when an edited decision cannot be saved." },
      "projectDecisions.saved": { description: "Confirmation after an edited decision is saved." },
      "projectDecisions.removed": { description: "Confirmation after a decision is removed." },
      "projectDecisions.error.conflict": { description: "Error: another person saved project settings first." },
      "projectDecisions.error.offline": { description: "Error: the device is offline, so the card cannot save." },
      "projectDecisions.error.permission": {
        description: "Error: the person's project role is too low to change decisions.",
      },
      "projectDecisions.error.failed": { description: "Error: saving failed for another reason." },
      "projectDecisions.card.durable": {
        description: "Line on an Autopilot question card: the answer will be kept and followed from now on.",
      },
      "projectDecisions.card.otherAnswer": {
        description: "Placeholder of a text box under the suggested answers, for an answer of the person's own.",
      },
      "projectDecisions.card.needsMaintainer": {
        description:
          "Error on a question card: this answer changes the 'Language profile' settings card, which only a " +
          "maintainer may change.",
      },
      "projectDecisions.card.reason.notStorable": {
        description:
          "Error on a question card: the typed answer is not a value the Language profile accepts. " +
          "'Language profile' is the name of a settings card.",
      },
      "projectDecisions.card.reason.tooLong": { description: "Error on a question card: the answer is too long to keep." },
      "projectDecisions.card.reason.full": {
        description: "Error on a question card: the project has reached the most decisions it can keep.",
      },
    },
  },
  surfaces: [],
})
