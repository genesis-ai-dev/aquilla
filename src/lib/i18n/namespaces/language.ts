import { defineNamespace } from "./types"

export const language = defineNamespace({
  keys: {
    "language.label": "Language",
    "language.switchTo": "Switch language to {language}",
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
          "Accessible label for the language switcher control. Read aloud by screen " +
          "readers; also the visible form label beside the control.",
        maxLength: 20,
      },
      "language.switchTo": {
        description:
          "Accessible description of a single option in the language switcher, naming " +
          "the language that option selects.",
        placeholders: {
          language:
            "Name of the target UI language, already written in that language's own " +
            "script (its endonym) — e.g. 'ไทย', 'العربية'. Do not translate the " +
            "substituted value.",
        },
      },
    },
  },
  // Declares no surface of its own: the switcher is shown inside the
  // `project-settings` surface, which `common` declares.
  surfaces: [],
})
