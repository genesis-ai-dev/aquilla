// Experimental feature-flag registry.
//
// `ProjectRecord.experimentalFlags` (src/lib/parsers/types.ts) forward-references
// this module: keys stored on the project record are defined here; unknown keys
// are ignored on read, and a project without the field falls back to each
// flag's registry default. Flags are DEVICE-LOCAL by design — they live on the
// IDB project record, never in ProjectWideSettings, so enabling an experiment
// on one machine never changes a collaborator's app.

import type { ProjectRecord } from "@/lib/parsers/types"
import type { MessageKey } from "@/lib/i18n/messages/en"

export interface FeatureFlagDefinition {
  /** Typed key for the short user-facing name shown next to the settings toggle. */
  labelKey: MessageKey
  /** Typed key for the plain-language explanation shown below the toggle. */
  descriptionKey: MessageKey
  /** Value used when the project record has no stored entry for the key. */
  default: boolean
}

export const FLAGS: Record<string, FeatureFlagDefinition> = {
  contextualTranslation: {
    labelKey: "autopilot.settings.controlsLabel",
    descriptionKey: "autopilot.settings.controlsDescription",
    // AQU-1103 — DEFAULT OFF, for everyone. Autopilot was always intended to be
    // opt-in, and shipping it default-on put its surfaces in front of every
    // project in production: the overview panel reporting "Needs attention" on
    // work nobody asked it to do. Discoverability was the argument for ON (the
    // flag gates whether the play button is visible, and a run costs nothing
    // until someone clicks it) — but an unrequested status claim on a PM's
    // overview is not discovery, and an experiment that turns itself on for
    // people who never opted in is the wrong default whatever it costs.
    //
    // This is the ONLY thing that enables Autopilot for a project that has
    // never stored a value: flags are device-local (see the module header) and
    // nothing server-side auto-enables a project — the auth-worker cron only
    // resumes runs that a person already started. So flipping this line turns
    // the surfaces off everywhere except where someone explicitly switched
    // them on in Project settings → Experimental, whose stored `true` still
    // wins (isFlagEnabled prefers the stored value over the default).
    default: false,
  },
}

/**
 * Read a flag for a project. Unknown keys always read as `false` (they are
 * ignored — a stored value for a key the registry no longer defines has no
 * effect). A known key absent from the record reads as its registry default.
 */
export function isFlagEnabled(
  project: Pick<ProjectRecord, "experimentalFlags">,
  key: string,
): boolean {
  const def = FLAGS[key]
  if (!def) return false
  const stored = project.experimentalFlags?.[key]
  return typeof stored === "boolean" ? stored : def.default
}
