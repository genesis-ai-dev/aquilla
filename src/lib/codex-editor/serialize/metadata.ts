import type { ProjectRecord } from "@/lib/parsers/types";
import type { CodexProjectMetadata } from "@/lib/codex-editor/types";

/**
 * Serialize project-level metadata (`metadata.json` at the repo root).
 *
 * Phase 2 does not expose any UI for editing project-level metadata, so we
 * pass the original on-disk JSON through verbatim. The `ProjectRecord` is
 * accepted for API symmetry with future phases that may override fields
 * like projectName or language tags from the in-memory project index.
 */
export function serializeProjectMetadata(
  _project: ProjectRecord,
  original: CodexProjectMetadata,
): CodexProjectMetadata {
  return JSON.parse(JSON.stringify(original));
}
