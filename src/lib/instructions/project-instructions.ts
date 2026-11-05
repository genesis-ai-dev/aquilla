// AQU-2342: the SPA's door to the one project-instructions text.
//
// The workspace holds the project as a ProjectRecord (the settings blob
// overlaid onto the IDB record), where the legacy `systemPrompt` rides inside
// `completionSettings`. `legacyProjectBriefText` (settings GET) carries the
// server-held sources — the agent's legacy brief and approved `decisions/`
// memories — already composed. This maps the record back to the blob shape the shared
// resolver reads, so the editor, the copilot and the Instructions editor all
// resolve the same text the workers do.

import type { ProjectRecord } from "@/lib/parsers/types"
import {
  resolveTranslationInstructions,
  type LegacyInstructionSources,
} from "../../../db/shared/translation-instructions"

export {
  TRANSLATION_INSTRUCTIONS_MAX_CHARS,
  instructionsPromptBlock,
  resolveTranslationInstructions,
} from "../../../db/shared/translation-instructions"

type InstructionSourceFields = Pick<
  ProjectRecord,
  | "translationInstructions"
  | "translationBrief"
  | "livingMemoryEntries"
  | "projectFacts"
  | "legacyProjectBriefText"
> & {
  /** Only the legacy `systemPrompt` is read (a migrate-on-read source). */
  completionSettings?: { systemPrompt?: string } | null
}

/** The resolved instructions for a project record ("" when it has none). The
 *  record's `legacyProjectBriefText` (from the settings GET) is the legacy
 *  source unless the caller passes its own. */
export function projectTranslationInstructions(
  project: Partial<InstructionSourceFields> | null | undefined,
  legacy?: LegacyInstructionSources,
): string {
  if (!project) return ""
  return resolveTranslationInstructions(
    {
      translationInstructions: project.translationInstructions,
      translationBrief: project.translationBrief,
      livingMemoryEntries: project.livingMemoryEntries,
      projectFacts: project.projectFacts,
      systemPrompt: project.completionSettings?.systemPrompt,
    },
    legacy ?? { projectBriefText: project.legacyProjectBriefText },
  )
}
