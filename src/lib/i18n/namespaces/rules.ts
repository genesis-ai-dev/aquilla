import { defineNamespace } from "./types"

/**
 * `rules` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `rules.` — the namespace's name is derived
 * from its first key, not from the filename.
 */
export const rules = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        "Translation rules, quality checks and health — the rule list and editor, the file-check pass and its findings drawer, and completion/health readouts. Note the user's OWN rule names and descriptions are content and are never keyed; only the chrome around them is.",
    },
  },
  surfaces: [],
})
