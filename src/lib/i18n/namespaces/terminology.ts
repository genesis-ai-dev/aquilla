import { defineNamespace } from "./types"

/**
 * `terminology` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `terminology.` — the namespace's name is derived
 * from its first key, not from the filename.
 */
export const terminology = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        "Termbase, glossary and translation memory — the translator's own reference tooling, used continuously while translating rather than occasionally. Read in the translator's language every working session.",
    },
  },
  surfaces: [],
})
