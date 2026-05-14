// Phase 2b: project-settings sync no longer rides on the file Y.Doc.
//
// Pre-Phase 2b this hook two-way-reconciled `completionSettings` between
// the file's Y.Doc `meta` map and the local IDB ProjectRecord — the file
// doc was the only project-scoped sync channel we had. Phase 2b moves
// project settings onto the auth-worker (PUT /api/v2/projects/:id/settings
// with optimistic-concurrency `ifMatchVersion`), so the two-way Y.Doc
// reconciliation is unnecessary and actively confusing (one source of
// truth: the server). `useProjectSettings` is already wired against the
// new endpoint, so this hook collapses to a no-op.
//
// Kept as a named export for call-site compatibility — Phase 2c removes
// it entirely along with the rest of the Y.Doc surface.

import type * as Y from "yjs"
import type { ProjectRecord } from "@/lib/parsers/types"

/**
 * Stub: no-op. Project settings flow through useProjectSettings →
 * writeProjectSettings → auth-worker in Phase 2b. There's nothing to
 * reconcile against the file Y.Doc anymore.
 */
export function useProjectSettingsSync(
  _doc: Y.Doc | null,
  _project: ProjectRecord | null,
  _refresh: () => void,
): void {
  /* phase 2b: settings sync handled server-side via useProjectSettings */
}
