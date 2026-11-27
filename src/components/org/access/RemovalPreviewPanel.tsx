/**
 * AQU-2321: the Remove dialog's body — the server's removal dry run, drawn.
 * Nothing here recomputes access; every line reads a field of RemovalPreview.
 * Kept grants this viewer may also remove become checkboxes, one per grant.
 */
import { roleLabel } from "@/components/access/labels"
import { Checkbox } from "@/components/ui/checkbox"
import { grantKey, shortList, type GrantRef } from "@/lib/access/edit-access"
import { formatScopePath, HIDDEN_ANCESTORS } from "@/lib/access/scope-path"
import type { ScopeRef } from "@/lib/access/types"
import { useFormat } from "@/lib/i18n/format"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

import { extraGrants, type KeptAccess, type RemovalState } from "./edit-access-data"

const placeName = (scope: ScopeRef) => (scope.hidden || !scope.name ? HIDDEN_ANCESTORS : scope.name)

function keepText(t: TFunction, kept: KeptAccess, date: (iso: string) => string): string {
  const vars = { role: roleLabel(t, kept.after.roleLevel), project: placeName(kept.project) }
  if (kept.after.source === "direct") {
    return kept.grantedAt
      ? t("org.access.remove.keepsDirect", { ...vars, date: date(kept.grantedAt) })
      : t("org.access.remove.keepsDirectUndated", vars)
  }
  if (kept.after.source === "team" && kept.grant) return t("org.access.remove.keepsTeam", { ...vars, team: placeName(kept.after.via) })
  if (kept.after.source === "org") return t("org.access.remove.keepsOrg", vars)
  if (kept.after.source === "creator") return t("org.access.remove.keepsCreator", vars)
  return t("org.access.remove.keepsHidden", vars)
}

/** AQU-2322: what removing a lane grant does to that lane. */
function laneText(t: TFunction, entry: { lane: ScopeRef; before: number | null; after: number | null }, wallOn: boolean): string {
  const lane = placeName(entry.lane)
  if (entry.after == null) return t(entry.before == null ? "org.access.remove.laneOpenedNothing" : "org.access.remove.laneLoses", { lane })
  return wallOn
    ? t("org.access.remove.laneStillOpens", { lane, role: roleLabel(t, entry.after) })
    : t("org.access.remove.laneNotRestricted", { lane })
}

function alsoText(t: TFunction, grant: GrantRef, kept: KeptAccess): string {
  if (grant.type === "org") return t("org.access.remove.alsoOrg")
  if (grant.type === "team") return t("org.access.remove.alsoTeam", { team: placeName(kept.after.via) })
  return t("org.access.remove.alsoDirect", { role: roleLabel(t, kept.after.roleLevel), project: placeName(kept.project) })
}

export function RemovalPreviewPanel({
  state,
  removing,
  checked,
  onToggle,
}: {
  state: RemovalState
  removing: readonly GrantRef[]
  checked: ReadonlySet<string>
  onToggle: (grant: GrantRef, on: boolean) => void
}) {
  const t = useT()
  const fmt = useFormat()
  if (state.status === "loading") return <p role="status" className="text-sm text-muted-foreground">{t("org.access.remove.loading")}</p>
  if (state.status === "error") return <p role="alert" className="text-sm text-destructive">{t("org.access.remove.error")}</p>
  if (state.status === "refused") return <p role="alert" data-testid="removal-refused" className="text-sm text-destructive">{state.message}</p>

  const { preview } = state
  const names = (places: readonly ScopeRef[]) => {
    const { shown, more } = shortList(places.map(placeName))
    return fmt.list(more > 0 ? [...shown, t("org.access.remove.andMore", { count: more })] : shown, { type: "conjunction" })
  }
  const extras = extraGrants(preview, removing)
  const date = (iso: string) => fmt.date(new Date(iso), { dateStyle: "medium" })

  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm" data-testid="removal-preview">
      <ul className="flex flex-col gap-1">
        {preview.removes.map((r) => (
          <li key={grantKey(r.grant) + formatScopePath(r.path)} data-testid="removal-removes">
            {r.grant.type === "team" && r.roleLevel == null
              ? t("org.access.remove.removesTeam", { team: placeName(r.path[r.path.length - 1]) })
              : r.withLastLane
                ? t("org.access.remove.removesWithLastLane", { role: roleLabel(t, r.roleLevel), path: formatScopePath(r.path) })
                : t("org.access.remove.removes", { role: roleLabel(t, r.roleLevel), path: formatScopePath(r.path) })}
          </li>
        ))}
      </ul>
      <section aria-labelledby="removal-loses" className="flex flex-col gap-1">
        <h3 id="removal-loses" className="font-medium">{t("org.access.remove.losesHeading")}</h3>
        <p data-testid="removal-loses">
          {preview.loses.length === 0
            ? t("org.access.remove.losesNothing")
            : t(preview.invite ? "org.access.remove.inviteLoses" : "org.access.remove.loses", { list: names(preview.loses) })}
        </p>
        {(preview.lanes ?? []).map((entry) => (
          <p key={entry.lane.id} data-testid="removal-lane">{laneText(t, entry, preview.wallOn === true)}</p>
        ))}
        {preview.leavesTeams.length > 0 && <p data-testid="removal-leaves-teams">{t("org.access.remove.leavesTeams", { list: names(preview.leavesTeams) })}</p>}
        {!preview.guest.before && preview.guest.after && <p>{t("org.access.remove.becomesGuest")}</p>}
      </section>
      {!preview.invite && preview.keeps.length > 0 && (
        <section aria-labelledby="removal-keeps" className="flex flex-col gap-1" data-testid="removal-keeps">
          <h3 id="removal-keeps" className="font-medium">{t("org.access.remove.keepsHeading")}</h3>
          <ul className="flex flex-col gap-1">
            {preview.keeps.map((kept) => (
              <li key={kept.project.id} data-testid="removal-kept">{keepText(t, kept, date)}</li>
            ))}
          </ul>
          {extras.length > 0 && (
            <fieldset className="mt-1 flex flex-col gap-2">
              <legend className="mb-1 text-muted-foreground">{t("org.access.remove.alsoRemove")}</legend>
              {extras.map(({ grant, kept }) => {
                const id = `also-${grantKey(grant)}`
                // Named by aria-labelledby, not a wrapping <label>: a label around
                // Base UI's checkbox forwards the click to its hidden input, which
                // toggled it twice under test and left it unchecked.
                return (
                  <div key={id} className="flex items-center gap-2">
                    <Checkbox
                      aria-labelledby={id}
                      checked={checked.has(grantKey(grant))}
                      onCheckedChange={(on) => onToggle(grant, on === true)}
                      data-testid="removal-also"
                    />
                    <span id={id}>{alsoText(t, grant, kept)}</span>
                  </div>
                )
              })}
            </fieldset>
          )}
        </section>
      )}
    </div>
  )
}
