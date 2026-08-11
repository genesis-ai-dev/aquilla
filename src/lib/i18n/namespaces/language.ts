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
          "Default accessible label for the language switcher control, used only when " +
          "a single instance of the switcher is on the page. Read aloud by screen " +
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
