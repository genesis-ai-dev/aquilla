import { defineNamespace } from "./types"

/**
 * `projectSettings` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `projectSettings.` — the namespace's name is derived
 * from its first key, not from the filename.
 */
export const projectSettings = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        'Creating a project and changing its settings — general details, source and target language, AI and validation configuration, and sharing. Mostly form labels above or beside their control, which have more room than nav or button text.',
    },
  },
  surfaces: [],
})
