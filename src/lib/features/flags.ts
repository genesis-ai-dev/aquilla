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
    label: "Contextual drafting",
    description:
      "An assistant that reads whole passages, drafts translations from the surrounding context, and stages them for your review. Early preview — stays on this device.",
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
