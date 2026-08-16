import { defineNamespace } from "./types"

/**
 * Preferences, personal/org/team settings surfaces.
 *
 * Registered ahead of its strings so the six parallel keying agents never
 * contend on `messages/en.ts` / `namespaces/index.ts` — see
 * `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`. A registered-but-empty namespace
 * is invisible to `CATALOG_CONTEXT` (its name is derived from its first key's
 * prefix), so this compiles and lints clean while empty.
 *
 * Declares no screenshot surface of its own: these controls live inside the
 * `project-settings` surface that `common` declares.
 */
export const settings = defineNamespace({
  keys: {},
  context: {
    _context: {
      description:
        "Account, organization and team settings surfaces: the Preferences screens, " +
        "organization settings (including the Monday.com integration), team settings, " +
        "and personal AI-provider configuration. Read by an administrator or an " +
        "individual user configuring how the product behaves for them — not while " +
        "translating. Prefer settled, formal register over conversational phrasing.",
      screenshot: "project-settings",
    },
    keys: {},
  },
  surfaces: [],
})
