import { defineNamespace } from "./types"

/**
 * Project workspace chrome that belongs to no single feature namespace: the
 * project shell and cards, creation dialog, member typeahead, timeline lanes,
 * post-edit metrics, status/offline/update banners and small shared dialogs.
 *
 * Registered ahead of its strings so the six parallel keying agents never
 * contend on `messages/en.ts` / `namespaces/index.ts` — see
 * `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`. A registered-but-empty namespace
 * is invisible to `CATALOG_CONTEXT` (its name is derived from its first key's
 * prefix), so this compiles and lints clean while empty.
 *
 * Declares no screenshot surface of its own: these strings render around the
 * `workspace-nav` and `editor-table` surfaces that `nav` and `editor` declare.
 */
export const workspace = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        "Project workspace chrome outside any one feature: the project shell, project " +
        "cards and creation dialog, member typeahead, audio/video timeline lanes, " +
        "post-edit metrics, and the connectivity/update banners. Seen constantly by " +
        "every translator using the product, usually out of the corner of the eye — " +
        "favour short, concrete wording over explanatory sentences.",
      screenshot: "workspace-nav",
    },
    keys: {},
  },
  surfaces: [],
})
