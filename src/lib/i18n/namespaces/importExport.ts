import { defineNamespace } from "./types"

/**
 * `importExport` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `importExport.` — the namespace's name is derived
 * from its first key, not from the filename.
 */
export const importExport = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        'Importing a source document into a project and exporting a translation back out — the format pickers, per-format hints, upload progress, collision handling and failure messages. Importing is the very first action a translator takes in Aquilla, so these strings are read before any other working surface.',
    },
  },
  surfaces: [],
})
