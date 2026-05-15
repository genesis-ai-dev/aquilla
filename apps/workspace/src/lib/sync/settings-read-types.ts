// Types for the identity project-settings read/write API (Phase 2b).
//
// Re-exports the shape already defined in `project-settings.ts` so all the
// Phase 2b read wrappers live under one consistent naming scheme. The
// canonical definition stays in `project-settings.ts` until Phase 3 moves
// types into `packages/data-model`.

export type {
  ProjectWideSettings,
  ProjectSettingsResponse,
  PatchResult as SettingsPatchResult,
} from "./project-settings"

/**
 * Outcome of a write attempt against PUT /api/v2/projects/:id/settings.
 * Distinct from `PatchResult` because the write wrapper folds the
 * "forbidden" + "error" cases into a single `error` arm for hook callers
 * that don't need to discriminate further.
 */
export type WriteSettingsOutcome =
  | { kind: "ok"; value: import("./project-settings").ProjectSettingsResponse }
  | {
      kind: "conflict"
      latest: import("./project-settings").ProjectSettingsResponse
    }
  | { kind: "error"; status: number; message: string }
