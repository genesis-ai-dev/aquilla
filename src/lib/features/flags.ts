// Experimental feature-flag registry.
//
// `ProjectRecord.experimentalFlags` (src/lib/parsers/types.ts) forward-references
// this module: keys stored on the project record are defined here; unknown keys
// are ignored on read, and a project without the field falls back to each
// flag's registry default. Flags are DEVICE-LOCAL by design — they live on the
// IDB project record, never in ProjectWideSettings, so enabling an experiment
// on one machine never changes a collaborator's app.

import type { ProjectRecord } from "@/lib/parsers/types"

export interface FeatureFlagDefinition {
  /** Short user-facing name shown next to the settings toggle. */
  label: string
  /** One-sentence user-facing explanation (plain words, no internal jargon). */
  description: string
  /** Value used when the project record has no stored entry for the key. */
  default: boolean
}

export const FLAGS: Record<string, FeatureFlagDefinition> = {
  contextualTranslation: {
    label: "Show Autopilot controls",
    description:
      "Shows Autopilot controls on this device. Turning this on does not start work, and hiding the controls does not stop a run. Choose Run Autopilot when you are ready; suggestions stay in review until you accept them.",
    // Default ON: this flag gates DISCOVERY, not spend. It decides whether the
    // play button is visible; a run only starts, and only costs anything, when
    // someone deliberately clicks it. Defaulting it off meant the feature could
    // only be found by someone who already knew it existed and went looking in
    // project settings for it — which is not a discovery path, it's a hiding
    // place. Flip this single line to hide it again.
    default: true,
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
