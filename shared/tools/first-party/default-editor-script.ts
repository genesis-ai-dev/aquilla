/**
 * The first-party default editor's script (see default-editor.ts): five parts
 * concatenated into one closure, plus the lucide icons and the list of app
 * UI strings it asks the host for (aquilla.ui.strings). Plain ES2020 in a
 * classic <script>, talking to Aquilla ONLY through `aquilla.*` — the same
 * bridge every extension gets, no privileged calls.
 */
import { DEFAULT_EDITOR_ICONS } from "./default-editor-icons"
import { EDITOR_CORE } from "./default-editor-core"
import { EDITOR_LAYOUT } from "./default-editor-layout"
import { EDITOR_ROWS } from "./default-editor-rows"
import { EDITOR_EDIT } from "./default-editor-edit"
import { EDITOR_FEATURES } from "./default-editor-features"

const PARTS = [EDITOR_CORE, EDITOR_LAYOUT, EDITOR_ROWS, EDITOR_EDIT, EDITOR_FEATURES]

const MILESTONE_VOCABS = ["chapter", "slide", "story", "section", "timeRange", "part", "group", "milestone"]
const MILESTONE_KEYS = MILESTONE_VOCABS.flatMap((v) =>
  ["previous", "next", "current", "findPlaceholder", "find", "empty"].map((k) => `editor.milestone.${v}.${k}`),
)

/** Every app string key the script uses (literal t("…") calls + the
 *  navigator's per-vocabulary keys). Exported for the catalog test. */
export const DEFAULT_EDITOR_STRING_KEYS: readonly string[] = [
  ...new Set([...PARTS.join("\n").matchAll(/\bt\("([A-Za-z0-9_.]+)"/g)].map((m) => m[1]).concat(MILESTONE_KEYS)),
].sort()

/** Strings the built-in editor itself hardcodes in English (no catalog key). */
const FALLBACK: Record<string, string> = {
  "open-details": "Open cell details",
  "remote-changed": "Someone else changed this cell while you were editing.",
  "discard-reload": "Discard and reload",
  "read-only": "Read-only",
  voice: "Voice this line",
  "view-term": "View term",
  "all-done": "Every cell is translated and validated.",
  "replace-title": "Replace existing translation?",
  "replace-validated-title": "Replace validated translation?",
  "replace-desc": "Replace the existing translation? The current text is preserved in cell history and can be recovered.",
  "replace-validated-desc":
    "This cell is validated — replacing it clears the validation. The current text is preserved in cell history and can be recovered.",
  replace: "Replace",
  "open-rule": "Open rule",
}

export const DEFAULT_EDITOR_SCRIPT = `
(function () {
  "use strict";
  var ICONS = ${JSON.stringify(DEFAULT_EDITOR_ICONS)};
  var FALLBACK = ${JSON.stringify(FALLBACK)};
  var STRING_KEYS = ${JSON.stringify(DEFAULT_EDITOR_STRING_KEYS)};
${PARTS.join("\n")}
})();
`
