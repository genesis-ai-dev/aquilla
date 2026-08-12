import type { ReactNode } from "react"
import { Lock } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * AQU-334: gates a Project Setup checklist step's body on the caller's
 * resolved project role (AD-12 max-wins, `project.syncRole.level`).
 *
 * Pattern source: `aquilla-specs/05-user-stories/customize-ai-settings.md`
 * Persona section — below-floor roles see the step rendered **read-only**
 * with an explanatory tooltip naming the required role, never hidden and
 * never fronted by a 403 popup. Mirrors `DisabledFieldTooltip` (used by
 * ProjectSettings.tsx for the same AQU-255 floor) but wraps a whole step
 * body rather than a single field, since a checklist step is a cluster of
 * inputs/buttons rather than one control.
 *
 * Floor choice per step (see SetupChecklistDrawer):
 *   - Invite collaborators → PROJECT_LEAD (500), matching the confirmed
 *     server floor on the actual write path (`POST /:projectId/members`,
 *     `INVITE_MIN_ROLE` in auth-worker/src/types.ts).
 *   - Instructions / voice & transcription → MAINTAINER (600), matching
 *     AQU-255's `EDIT_ROLE_FLOOR` in useProjectSettings.ts and the server's
 *     `SETTINGS_WRITE_MIN_ROLE` on `PUT/PATCH /:projectId/settings` — the
 *     endpoint these values are eventually synced through. NOTE: the spec
 *     (`customize-ai-settings.md`) documents project_lead (500) for most
 *     settings; AQU-255 deliberately raised the client+server floor to
 *     maintainer (600) for the *shared* project_settings row. We follow the
 *     already-shipped 600 here for consistency rather than reopening that
 *     decision — flagged as a spec/doc divergence in the AQU-334 report.
 *     SWARM-TODO(AQU-334): AiInstructionsStep/AiModelsStep currently persist
 *     via `useSaveCompletionSettings`/`patchProject` (IndexedDB only) and
 *     never call the gated server endpoint at all — this UI gate closes the
 *     visible path, but the underlying write has no server-side floor to hit
 *     from this surface. Follow-up: route these steps' saves through
 *     `useProjectSettings.patch` (or an equivalent server round-trip) so the
 *     403 safety net actually applies.
 *
 * `roleLevel === null` (no server-side membership resolved — e.g. a
 * local-only/unsynced project) is treated as allowed: there is no server
 * floor to enforce against, matching `useProjectSettings`'s "unsynced
 * project" fallback (roleLevel == null → apply locally, no role gate).
 */
export function RoleGatedStep({
  roleLevel,
  requiredRole,
  actionLabel,
  children,
}: {
  /** Caller's resolved project role level, or null if unsynced/unknown. */
  roleLevel: number | null
  /** Minimum role level required to use this step's action. */
  requiredRole: number
  /** Human-facing description of the gated action, e.g. "Editing translation
   *  instructions". Used to build the tooltip: "<actionLabel> is available to
   *  <Role>s and above." */
  actionLabel: string
  children: ReactNode
}) {
  const t = useT()
  const allowed = roleLevel == null || roleLevel >= requiredRole
  if (allowed) return <>{children}</>

  // AQU-623 class of bug: the plural role noun ("Maintainers") comes from the
  // catalog's plural() form, never from concatenating "s" onto the singular.
  const tooltip = `${actionLabel} is available to ${resolveRoleName(t, requiredRole, { plural: true })} and above.`

  return (
    <AppTooltip content={tooltip}>
      <div
        aria-disabled="true"
        data-testid="role-gated-step"
        className="pointer-events-none relative opacity-60 select-none"
      >
        <div className="absolute -top-1 -end-1 z-10 flex h-5 w-5 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden />
        </div>
        {children}
      </div>
    </AppTooltip>
  )
}
