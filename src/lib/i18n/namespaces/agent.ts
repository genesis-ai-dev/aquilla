import { defineNamespace } from "./types"

/**
 * Translation-agent surfaces: workbench, working set, memory/brief, proposals
 * and the changeset approval gate.
 *
 * Registered ahead of its strings so the six parallel keying agents never
 * contend on `messages/en.ts` / `namespaces/index.ts` — see
 * `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`. A registered-but-empty namespace
 * is invisible to `CATALOG_CONTEXT` (its name is derived from its first key's
 * prefix), so this compiles and lints clean while empty.
 *
 * Declares no screenshot surface of its own: the workbench and the approval
 * gate render over the `editor-table` surface that `editor` declares.
 */
export const agent = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        "The in-app translation agent: its workbench panel, the working set of files " +
        "it may touch, its memory/brief editor, the proposal receipts it returns, and " +
        "the changeset approval screen where a human accepts or rejects the agent's " +
        "staged writes. Nothing here is applied without that human approval, so the " +
        "wording must keep the distinction between a PROPOSED change and an APPLIED " +
        "one unmistakable in translation.",
      screenshot: "editor-table",
    },
    keys: {},
  },
  surfaces: [],
})
