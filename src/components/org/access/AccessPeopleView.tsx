import { RoleBadge } from "@/components/access/RoleBadge"
import { PlaceBreadcrumb } from "@/components/access/PlaceBreadcrumb"
import { UserChip } from "@/components/UserChip"
import { MemberInspectorTrigger } from "@/components/access/MemberInspectorTrigger"
import { scopePathKey } from "@/lib/access/scope-path"
import type { ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { accessNodeHref } from "./access-anchors"
import type { OrgAccessPerson } from "./org-access-data"

/**
 * AQU-1352 §3.6: one row per person; each grant is a chip reading
 * "<role pill> <place breadcrumb>". AQU-2317 made both halves components: the
 * role is a rung on the ladder and its shape says direct or inherited, and the
 * place goes through the breadcrumb helper so it reads the same here, in the
 * tree, in the dialogs and in the CSV.
 */
export function AccessPeopleView({ people, org }: { people: OrgAccessPerson[]; org: ScopeRef }) {
  const t = useT()
  return (
    <ul className="flex flex-col divide-y rounded-md border" data-testid="access-people">
      {people.map((p) => (
        <li key={p.userId} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start">
          <div className="flex w-48 shrink-0 items-baseline gap-2">
            <MemberInspectorTrigger userId={p.userId} username={p.displayName} from={{ type: "org", id: org.id }} herePath={[org]}>
              <UserChip userId={p.userId} username={p.displayName} size="xs" nameClassName="text-sm font-normal" />
            </MemberInspectorTrigger>
            {p.isGuest && <span className="text-xs text-muted-foreground">{t("org.access.inspector.guest")}</span>}
          </div>
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {p.grants.map((g, i) => (
              <li
                key={`${scopePathKey(g.scopePath)}:${i}`}
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
                data-testid="access-chip"
              >
                <RoleBadge roleLevel={g.roleLevel} origin={g.origin} hrefFor={accessNodeHref} />
                <PlaceBreadcrumb path={g.scopePath} className="text-xs" />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}
