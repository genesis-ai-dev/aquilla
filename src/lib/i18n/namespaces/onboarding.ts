import { defineNamespace } from "./types"

/**
 * `onboarding` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `onboarding.` — the namespace's name is derived
 * from its first key, not from the filename.
 */
export const onboarding = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        "First-run onboarding and account preferences — the setup checklist that teaches the app, the product tour, and the personal settings screens (profile, appearance, API tokens). These are the first strings a new translator reads, often before they understand the product's vocabulary, so prefer plain wording over internal jargon.",
    },
  },
  surfaces: [],
})
