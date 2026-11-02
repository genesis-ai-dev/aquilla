// AQU-2342: the SPA's door to the one project-instructions text.
//
// The workspace holds the project as a ProjectRecord (the settings blob
// overlaid onto the IDB record), where the legacy `systemPrompt` rides inside
// `completionSettings`. This maps the record back to the blob shape the shared
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
  | "completionSettings"
  | "legacyProjectBriefText"
>

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
      systemPrompt: project.completionSettings?.systemPrompt,
    },
    legacy ?? { projectBriefText: project.legacyProjectBriefText },
  )
}
