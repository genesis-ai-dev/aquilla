import { defineNamespace } from "./types"

export const language = defineNamespace({
  keys: {
    "language.label": "Language",
    "language.switchTo": "Switch language to {language}",
    "language.switcher.chrome": "Quick language switch",
    "language.switcher.settingsRow": "UI language",
  },
  context: {
    _context: {
      description:
        "UI-language switcher in settings and the app chrome, which changes the " +
        "language of the interface itself (not the language being translated in the " +
        "project). These strings are read by someone who may not yet understand the " +
        "current UI language.",
      screenshot: "project-settings",
    },
    keys: {
      "language.label": {
        description:
          "Default accessible label for the language switcher, used only when a single " +
          "instance of it is on the page. The switcher is a globe icon button with no " +
          "visible text, so this is read by screen readers and shown as its tooltip — " +
          "it is never seen as a form label.",
        maxLength: 20,
      },
      "language.switchTo": {
        description:
          "Accessible name of one row in the language menu, naming the language that " +
          "row selects. The row's visible text is just the endonym, so this is the only " +
          "place a screen-reader user is told what choosing it does — keep it a full, " +
          "self-contained action.",
        placeholders: {
          language:
            "Name of the target UI language, already written in that language's own " +
            "script (its endonym) — e.g. 'ไทย', 'العربية'. Do not translate the " +
            "substituted value.",
        },
      },
      "language.switcher.chrome": {
        description:
          "Accessible name for the language switcher mounted in the persistent app " +
          "chrome (sidebar footer) — a quick switch that stays reachable without " +
          "leaving the current screen. Two switcher instances are on-screen together " +
          "at /preferences/language (this one plus 'language.switcher.settingsRow'); " +
          "a screen reader announces both, so this translation MUST read as a distinct " +
          "name from that one and from 'language.label' — do not translate it as a " +
          "bare 'Language'.",
        maxLength: 24,
      },
      "language.switcher.settingsRow": {
        description:
          "Accessible name for the language switcher control on its dedicated " +
          "Preferences settings row (also the row's visible label). Two switcher " +
          "instances are on-screen together at /preferences/language (this one plus " +
          "'language.switcher.chrome'); a screen reader announces both, so this " +
          "translation MUST read as a distinct name from that one and from " +
          "'language.label' — do not translate it as a bare 'Language'.",
        maxLength: 24,
      },
    },
  },
  // Declares no surface of its own: the switcher is shown inside the
  // `project-settings` surface, which `common` declares.
  surfaces: [],
})
