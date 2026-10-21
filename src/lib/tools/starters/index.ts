/** Reviewed starter extensions offered on the Smart Extensions page. */

import type { ToolManifest } from "../../../../shared/tools/manifest"
import { FOCUS_EDITOR_MANIFEST, FOCUS_EDITOR_SOURCE } from "./focus-editor-source"
import { HEATMAP_MANIFEST, HEATMAP_SOURCE } from "./heatmap-source"

export interface StarterExtension {
  manifest: ToolManifest
  source: string
}

function manifestOf(m: { name: string; description: string; scopes: readonly ToolManifest["scopes"][number][]; mounts: readonly ToolManifest["mounts"][number][]; apiRev: number }): ToolManifest {
  return { name: m.name, description: m.description, scopes: [...m.scopes], mounts: [...m.mounts], apiRev: m.apiRev }
}

export const STARTER_EXTENSIONS: StarterExtension[] = [
  { manifest: manifestOf(HEATMAP_MANIFEST), source: HEATMAP_SOURCE },
  { manifest: manifestOf(FOCUS_EDITOR_MANIFEST), source: FOCUS_EDITOR_SOURCE },
]
